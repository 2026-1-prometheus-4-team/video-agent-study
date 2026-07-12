import { config } from "@remotion/eslint-config-flat";

export default [
  ...config,
  {
    rules: {
      // Allow underscore-prefixed args/vars as the intentional "unused"
      // marker. The atom registry's IntrinsicDurationFn signature passes
      // (props, ctx) to every atom but most only need `props`, so `_ctx`
      // is documentation rather than dead code.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
];
