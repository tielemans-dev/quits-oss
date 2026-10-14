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
  WORKFLOWS = %w[ci oss-boundary].to_h do |name|
    [name, YAML.load_file("#{ROOT}/.github/workflows/#{name}.yml")]
  end
  JOBS = { 'ci' => %w[verify shared-browser], 'oss-boundary' => %w[verify-oss-boundary] }

  # Evaluate the workflow's actual expressions in a bounded context. Explicitly
  # require a status function so GitHub's implicit success() cannot mask failure.
  def expression(source, context)
    code = source.delete_prefix('${{').delete_suffix('}}').strip
    context.sort_by { |key, _| -key.length }.each do |key, value|
      code = code.gsub(key, JSON.generate(value))
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
        %w[success failure skipped cancelled].product(['true', 'false', '']).each do |result, output|
          [false, true].each do |cancelled|
            actual = expression(condition, {
              'cancelled()' => cancelled,
              'needs.paths.result' => result,
              'needs.paths.outputs.run-expensive' => output,
            })
            expected = !cancelled && (result != 'success' || output != 'false')
            assert_equal expected, actual, "#{name}/#{job}: #{result}, #{output}, cancelled=#{cancelled}"
          end
        end
      end
    end
  end

  def test_events_concurrency_and_check_names
    WORKFLOWS.each do |name, workflow|
      # YAML 1.1 interprets the unquoted GitHub key 'on' as true.
      assert_equal %w[pull_request push], workflow.fetch(true).keys.sort
      group = workflow.fetch('concurrency').fetch('group')
      cancel = workflow.fetch('concurrency').fetch('cancel-in-progress')
      events = [
        ['pull_request', 'refs/pull/155/merge', true],
        ['push', 'refs/heads/main', false],
        ['push', 'refs/heads/topic', false],
        ['push', 'refs/tags/v1.0.0', false],
        ['release', 'refs/tags/v1.0.0', false],
        ['workflow_dispatch', 'refs/heads/main', false],
        ['pull_request_target', 'refs/heads/main', false],
      ]
      events.each do |event, ref, should_cancel|
        groups = [100, 101].map do |run_id|
          context = { 'github.workflow' => name, 'github.ref' => ref,
                      'github.event_name' => event, 'github.run_id' => run_id }
          assert_equal should_cancel, expression(cancel, context), "#{event}/#{ref}"
          group.gsub(/\$\{\{.*?\}\}/) { |part| expression(part, context).to_s }
        end
        assert_equal(event == 'pull_request', groups.first == groups.last)
      end
    end
    assert_equal 'Shared product browser scenarios', WORKFLOWS['ci']['jobs']['shared-browser']['name']
    JOBS.each do |name, jobs|
      jobs.each { |job| assert_equal 'paths', WORKFLOWS[name]['jobs'][job]['needs'] }
    end
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
    [status.success?, output.strip, stderr]
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
        assert_equal "run-expensive=#{expected}", output, paths.inspect
      end
      %w[push release workflow_dispatch pull_request_target].each do |event|
        ok, output, stderr = classify(workflow, event, ['docs/guide.md'])
        assert ok, stderr
        assert_equal 'run-expensive=true', output
      end
      ok, output, = classify(workflow, 'pull_request', [], diff_failure: true)
      refute ok
      assert_empty output
    end
  end

  def test_real_git_rename_and_three_dot_diff
    WORKFLOWS.each_value do |workflow|
      Dir.mktmpdir('ci-paths-git-') do |dir|
        git = lambda do |*args|
          _, stderr, status = Open3.capture3('git', *args, chdir: dir)
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
        assert_equal 'run-expensive=false', output
        File.delete("#{dir}/output")
        git.call('mv', 'runtime.ts', 'docs/runtime.md')
        git.call('commit', '-qm', 'rename runtime to docs')
        ok, output, stderr = run_classifier(workflow, dir, 'pull_request')
        assert ok, stderr
        assert_equal 'run-expensive=true', output
      end
    end
  end
end

fixtures = CiPathsTest.new
tests = CiPathsTest.instance_methods.grep(/^test_/).sort
tests.each { |test| fixtures.public_send(test) }
puts "#{tests.length} fixture groups, #{fixtures.assertions} assertions passed"
