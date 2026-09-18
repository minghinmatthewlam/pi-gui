declare module "highlight.js/lib/core" {
  import hljs from "highlight.js";
  export default hljs;
}

declare module "highlight.js/lib/languages/bash" {
  import hljs from "highlight.js";
  const language: Parameters<typeof hljs.registerLanguage>[1];
  export default language;
}

declare module "highlight.js/lib/languages/javascript" {
  import hljs from "highlight.js";
  const language: Parameters<typeof hljs.registerLanguage>[1];
  export default language;
}

declare module "highlight.js/lib/languages/json" {
  import hljs from "highlight.js";
  const language: Parameters<typeof hljs.registerLanguage>[1];
  export default language;
}

declare module "highlight.js/lib/languages/python" {
  import hljs from "highlight.js";
  const language: Parameters<typeof hljs.registerLanguage>[1];
  export default language;
}

declare module "highlight.js/lib/languages/typescript" {
  import hljs from "highlight.js";
  const language: Parameters<typeof hljs.registerLanguage>[1];
  export default language;
}
