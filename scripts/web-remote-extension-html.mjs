/**
 * 提取 index.html 中的内联 <script> 到独立文件 bootstrap-theme.js，
 * 以满足 Manifest V3 默认禁止 extension_pages 内联脚本的 CSP 要求。
 */
export function extractInlineBootstrapScriptForExtension(html) {
  const inlineScriptRegex = /<script>\s*(\(\(\)\s*=>\s*\{[\s\S]*?\}\)\(\);)\s*<\/script>/u;
  const match = html.match(inlineScriptRegex);
  if (!match) {
    throw new Error("Could not find inline bootstrap theme script in index.html");
  }
  const scriptContent = `${match[1]}\n`;
  const transformedHtml = html
    .replace('<html lang="en">', '<html lang="en" data-codez-browser-extension="true">')
    .replace(inlineScriptRegex, '<script src="./bootstrap-theme.js"></script>');
  return {
    html: transformedHtml,
    scriptContent,
  };
}
