import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const asFlatConfig = (config) => (Array.isArray(config) ? config : config.default);

const eslintConfig = [
  {
    ignores: ["**/.next/**", "**/node_modules/**"],
  },
  ...asFlatConfig(nextCoreWebVitals),
  ...asFlatConfig(nextTypescript),
];

export default eslintConfig;
