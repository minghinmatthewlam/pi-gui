import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkGfm from "remark-gfm";

// CommonMark's punctuation boundaries otherwise leave 是**“中文”**。 literal.
export const MARKDOWN_PLUGINS = [remarkGfm, remarkCjkFriendly];
