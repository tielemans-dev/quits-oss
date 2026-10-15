# Lightweight static workflow fixtures: ruby scripts/__tests__/ci-paths.test.rb
require 'json'
require 'open3'
require 'tmpdir'
require 'yaml'

class CiPathsTest
  attr_reader :assertions

  def initialize
    @assertions = 0
  end

  def assert(value, message = 'Assertion failed')
    @assertions += 1
    raise message unless value
  end

  def assert_equal(expected, actual, message = '')
    assert(expected == actual, "#{message}: expected #{expected.inspect}, got #{actual.inspect}")
  end

  def assert_includes(value, part)
    assert(value.include?(part), "#{value.inspect} must include #{part.inspect}")
  end

  def refute(value)
    assert(!value)
  end

  def assert_empty(value)
    assert(value.empty?)
  end

  ROOT = File.expand_path('../..', __dir__)
  ALL_WORKFLOWS = Dir.glob("#{ROOT}/.github/workflows/*.{yml,yaml}").to_h do |file|
    [File.basename(file, File.extname(file)), YAML.load_file(file)]
  end
  WORKFLOWS = ALL_WORKFLOWS.slice('ci', 'oss-boundary')
  DRAFT_GUARD = "github.event_name != 'pull_request' || !github.event.pull_request.draft"
  JOBS = { 'ci' => %w[lint typecheck unit runtime shared-browser-worker], 'oss-boundary' => %w[boundary-worker] }

  # Evaluate the workflow's actual expressions in a bounded context. Explicitly
  # require a status function so GitHub's implicit success() cannot mask failure.
  def expression(source, context)
    code = source.delete_prefix('${{').delete_suffix('}}').strip
    context.sort_by { |key, _| -key.length }.each do |key, value|
      code = code.gsub(key, value.nil? ? 'nil' : JSON.generate(value))
    end
    code = code.gsub(/startsWith\(("[^"]*"), ('[^']*')\)/, '\1.start_with?(\2)')
    raise "Unresolved expression: #{code}" unless code.match?(/\A[\s\w\d"'!&|?().=:\/-]*\z/)
    eval(code) # Only repository workflow expressions, never event payload code.
  end

  def test_cancellation_and_failed_paths
    WORKFLOWS.each do |name, workflow|
      JOBS.fetch(name).each do |job|
        condition = workflow.fetch('jobs').fetch(job).fetch('if')
        assert_includes condition, '!cancelled()'
        %w[success failure skipped cancelled].product(['true', 'false', ''], ['true', 'false', '']).each do |result, output, browser|
          [false, true].product([false, true]).each do |cancelled, draft|
            actual = expression(condition, {
              'cancelled()' => cancelled,
              'github.event_name' => 'pull_request',
              'github.event.pull_request.draft' => draft,
              'needs.paths.result' => result,
              'needs.paths.outputs.run-expensive' => output,
              'needs.paths.outputs.run-browser' => browser,
            })
            relevant_output = job == 'shared-browser-worker' ? browser : output
            expected = !draft && !cancelled && (result != 'success' || relevant_output != 'false')
            assert_equal expected, actual, "#{name}/#{job}: #{result}, expensive=#{output}, browser=#{browser}, cancelled=#{cancelled}"
          end
        end
      end
    end
  end

  def test_events_concurrency_and_check_names
    ALL_WORKFLOWS.each do |name, workflow|
      # YAML 1.1 interprets the unquoted GitHub key 'on' as true.
      triggers = workflow.fetch(true)
      if triggers.key?('push')
        push = triggers.fetch('push')
        assert_equal ['v*'], push.fetch('tags')
        assert_equal ['main'], push.fetch('branches') if push.key?('branches')
        refute push.key?('branches-ignore')
        refute push.key?('tags-ignore')
      end
      if triggers.key?('pull_request')
        assert_equal %w[opened synchronize reopened ready_for_review converted_to_draft], triggers['pull_request']['types']
      end
      assert_equal %w[merge_group pull_request push], triggers.keys.sort if WORKFLOWS.key?(name)
      refute triggers.key?('merge_group') unless WORKFLOWS.key?(name)
      next unless triggers.key?('pull_request')
      group = workflow.fetch('concurrency').fetch('group')
      cancel = workflow.fetch('concurrency').fetch('cancel-in-progress')
      events = [
        ['pull_request', 'refs/pull/155/merge', true],
        ['push', 'refs/heads/main', false],
        ['merge_group', 'refs/heads/gh-readonly-queue/main/pr-155', false],
        ['push', 'refs/heads/topic', false],
        ['push', 'refs/tags/v1.0.0', false],
        ['release', 'refs/tags/v1.0.0', false],
        ['workflow_dispatch', 'refs/heads/main', false],
      ]
      events.each do |event, ref, should_cancel|
        groups = [100, 101].map do |run_id|
          context = { 'github.workflow' => name, 'github.ref' => ref,
                      'github.event.pull_request.number' => event == 'pull_request' ? 155 : nil,
                      'github.event_name' => event, 'github.run_id' => run_id }
          assert_equal should_cancel, expression(cancel, context), "#{event}/#{ref}"
          group.gsub(/\$\{\{.*?\}\}/) { |part| expression(part, context).to_s }
        end
        # Unique non-PR groups prevent GitHub from replacing pending main/tag runs.
        assert_equal(event == 'pull_request', groups.first == groups.last)
        assert_equal "#{name}-#{event == 'pull_request' ? 155 : 100}", groups.first
      end
    end
    assert_equal 'Shared product browser scenarios', WORKFLOWS['ci']['jobs']['shared-browser']['name']
    JOBS.each do |name, jobs|
      jobs.each { |job| assert_equal 'paths', WORKFLOWS[name]['jobs'][job]['needs'] }
    end
  end

  def test_pr_jobs_skip_drafts
    ALL_WORKFLOWS.each do |name, workflow|
      workflow.fetch('jobs').each do |id, job|
        assert_equal 'ubuntu-latest', job.fetch('runs-on')
        next unless workflow.fetch(true).key?('pull_request')
        condition = job.fetch('if')
        assert_includes condition, DRAFT_GUARD
        context = condition.scan(/(?:github|needs)\.[\w.-]+/).to_h { |key| [key, nil] }
        context.merge!('github.event_name' => 'pull_request', 'github.event.pull_request.draft' => true,
                       'always()' => true, 'cancelled()' => false)
        refute expression(condition, context)
      end
    end
  end

  def test_required_gates_and_dependency_graph
    gates = { 'ci' => {
      'ci-ok' => %w[paths lint typecheck unit runtime shared-browser-worker],
      'verify' => ['ci-ok'], 'shared-browser' => %w[paths shared-browser-worker],
    }, 'oss-boundary' => { 'verify-oss-boundary' => %w[paths boundary-worker] } }
    WORKFLOWS.each do |name, workflow|
      jobs = workflow.fetch('jobs')
      gates.fetch(name).each do |id, dependencies|
        condition = jobs.fetch(id).fetch('if')
        assert_includes condition, 'always()'
        %w[pull_request push merge_group].product([false, true]).each do |event, draft|
          actual = expression(condition, { 'always()' => true, 'github.event_name' => event,
                                           'github.event.pull_request.draft' => draft })
          assert_equal(event != 'pull_request' || !draft, actual, "#{name}/#{id}: #{event}, draft=#{draft}")
        end
        assert_equal dependencies.sort, Array(jobs.fetch(id).fetch('needs')).sort
      end
      visited = []
      visit = lambda do |id, trail|
        refute trail.include?(id)
        jobs.fetch(id)
        next if visited.include?(id)
        Array(jobs.fetch(id)['needs']).each { |dep| visit.call(dep, trail + [id]) }
        visited << id
      end
      jobs.each_key { |id| visit.call(id, []) }
    end
    verify = WORKFLOWS['ci']['jobs']['verify']['steps'].first
    assert_equal '${{ needs.ci-ok.result }}', verify['env']['CI_RESULT']
    assert_equal 'test "$CI_RESULT" = success', verify['run']
  end

  def classify(workflow, event, paths, diff_failure: false)
    Dir.mktmpdir('ci-paths-') do |dir|
      File.binwrite("#{dir}/fixture", paths.map { |path| "#{path}\0" }.join)
      File.write("#{dir}/git", "#!/bin/bash\n#{diff_failure ? 'exit 1' : 'cat "$RUNNER_TEMP/fixture"'}\n")
      File.chmod(0o755, "#{dir}/git")
      run_classifier(workflow, dir, event, { 'PATH' => "#{dir}:#{ENV.fetch('PATH')}" })
    end
  end

  def run_classifier(workflow, dir, event, extra = {})
    steps = workflow.fetch('jobs').fetch('paths').fetch('steps')
    script = steps.find { |step| step['id'] == 'classify' }.fetch('run')
    env = { 'EVENT_NAME' => event, 'BASE_SHA' => 'HEAD~1', 'HEAD_SHA' => 'HEAD',
            'RUNNER_TEMP' => dir, 'GITHUB_OUTPUT' => "#{dir}/output" }.merge(extra)
    _, stderr, status = Open3.capture3(env, 'bash', '-e', '-c', script, chdir: dir)
    output = File.exist?("#{dir}/output") ? File.read("#{dir}/output") : ''
    outputs = output.lines.to_h { |line| line.strip.split('=', 2) }
    [status.success?, outputs, stderr]
  end

  def test_classifier_paths_and_errors
    fixtures = [
      [['COPY.md'], false],
      [['docs/guide.md', 'docs/nested/guide.mdx'], false],
      [['docs/space and\nnewline.md'.gsub('\\n', "\n")], false],
      [['README.md'], true], [['CONTRIBUTING.md'], true],
      [['apps/oss/README.md'], true], [['AGENTS.md'], true], [['CLAUDE.md'], true],
      [['docs/guide.md', 'README.md'], true],
      [['apps/oss/src/server.ts'], true], [['packages/contracts/src/runtime.ts'], true],
      [['packages/shared/src/index.ts'], true], [['scripts/check-oss-boundaries.sh'], true],
      [['.github/workflows/ci.yml'], true], [['bun.lock'], true], [['docs/data.json'], true],
      [[], true],
    ]
    WORKFLOWS.each_value do |workflow|
      fixtures.each do |paths, expected|
        ok, output, stderr = classify(workflow, 'pull_request', paths)
        assert ok, stderr
        assert_equal expected.to_s, output['run-expensive'], paths.inspect
      end
      %w[push merge_group release workflow_dispatch pull_request_target].each do |event|
        ok, output, stderr = classify(workflow, event, ['docs/guide.md'])
        assert ok, stderr
        assert_equal 'true', output['run-expensive']
      end
      ok, output, = classify(workflow, 'pull_request', [], diff_failure: true)
      refute ok
      assert_empty output
    end
  end

  def test_browser_classifier_paths_and_errors
    workflow = WORKFLOWS.fetch('ci')
    fixtures = [
      [['COPY.md'], false], [['README.md'], false], [['apps/oss/README.md'], false],
      [['docs/x.json'], false], [['.github/workflows/ci.yml'], false],
      [['docs/x.json', 'README.md', '.github/workflows/ci.yml'], false],
      [['docs/x.json', 'README.md', '.github/workflows/ci.yml', 'apps/oss/src/x.ts'], true],
      [['apps/oss/src/x.ts'], true], [[], true],
    ]
    fixtures.each do |paths, expected|
      ok, output, stderr = classify(workflow, 'pull_request', paths)
      assert ok, stderr
      assert_equal expected.to_s, output['run-browser'], paths.inspect
    end
    %w[push merge_group release workflow_dispatch pull_request_target].each do |event|
      ok, output, stderr = classify(workflow, event, ['docs/guide.md'])
      assert ok, stderr
      assert_equal 'true', output['run-browser'], event
    end
    ok, output, = classify(workflow, 'pull_request', [], diff_failure: true)
    refute ok
    assert_empty output
  end

  def test_real_git_rename_and_three_dot_diff
    WORKFLOWS.each_value do |workflow|
      Dir.mktmpdir('ci-paths-git-') do |dir|
        git = lambda do |*args|
          _, stderr, status = Open3.capture3('git', '--no-pager', *args, chdir: dir)
          assert status.success?, stderr
        end
        git.call('init', '-q')
        git.call('config', 'user.name', 'Fixture')
        git.call('config', 'user.email', 'fixture@example.test')
        File.write("#{dir}/runtime.ts", 'runtime')
        git.call('add', '.')
        git.call('commit', '-qm', 'baseline')
        Dir.mkdir("#{dir}/docs")
        File.write("#{dir}/docs/guide.md", 'guide')
        git.call('add', '.')
        git.call('commit', '-qm', 'docs')
        ok, output, stderr = run_classifier(workflow, dir, 'pull_request')
        assert ok, stderr
        assert_equal 'false', output['run-expensive']
        File.delete("#{dir}/output")
        git.call('mv', 'runtime.ts', 'docs/runtime.md')
        git.call('commit', '-qm', 'rename runtime to docs')
        ok, output, stderr = run_classifier(workflow, dir, 'pull_request')
        assert ok, stderr
        assert_equal 'true', output['run-expensive']
      end
    end
  end
end

fixtures = CiPathsTest.new
tests = CiPathsTest.instance_methods.grep(/^test_/).sort
tests.each { |test| fixtures.public_send(test) }
puts "#{tests.length} fixture groups, #{fixtures.assertions} assertions passed"
