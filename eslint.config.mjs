// App standard WEB-4: no HTML string reaches a DOM sink. eslint-plugin-no-unsanitized flags innerHTML,
// outerHTML, insertAdjacentHTML, document.write and their kin; the page also runs Trusted Types with no
// policy, so a sink that slipped past this would throw at runtime. Only these rules run here: style is not
// this file's job. `npm run lint`, and CI runs it before the tests.
import nounsanitized from "eslint-plugin-no-unsanitized";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["dist/**", "node_modules/**", "traces/**"] },
  {
    files: ["web/src/**/*.{ts,tsx}", "server/**/*.ts"],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "no-unsanitized": nounsanitized },
    rules: { "no-unsanitized/method": "error", "no-unsanitized/property": "error" },
  },
];
