module.exports = {
  "*.{js,jsx,ts,tsx}": "eslint --fix --quiet",
  "*.{js,jsx,ts,tsx,json,css,md,html,yml,yaml}": "prettier --write",
  "*.json": "prettier --write",
  "*.{md,html,yml,yaml}": "prettier --write",
  "*.swift": "swiftformat",
}
