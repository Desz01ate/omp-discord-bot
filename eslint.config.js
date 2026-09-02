import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "build/**", "node_modules/**", "coverage/**", ".omx/**"],
  },
  {
    files: ["**/*.ts", "**/*.js"],
    plugins: {
      "@stylistic": stylistic,
    },
    languageOptions: {
      parser: tseslint.parser,
    },
    rules: {
      curly: ["error", "all"],
      "@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: false }],
    },
  },
);
