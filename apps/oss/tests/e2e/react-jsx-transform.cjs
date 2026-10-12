// Playwright defaults JSX to serializable browser-mount objects. Direct Node PDF
// rendering needs React elements, including inside imported production components.
module.exports = function reactJsxTransform() {
  return {
    name: "seller-vat-node-react-jsx",
    pre(file) {
      file.ast.comments.unshift({ type: "CommentBlock", value: " @jsxImportSource react " })
    },
  }
}
