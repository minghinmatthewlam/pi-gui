/** The app owns the bridge; an extension contributes only its prebuilt mount module. */
export function extensionFrameDocument(input: {
  readonly connectionId: string;
  readonly frontendUrl: string;
  readonly bridgeUrl: string;
  readonly nonce: string;
}): string {
  const literal = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;min-height:100%;font:13px system-ui}body{background:var(--background);color:var(--foreground)}#root{min-height:100vh}.host-error{padding:16px;white-space:pre-wrap}</style>
</head><body><div id="root" role="main"></div>
<script type="module" nonce="${input.nonce}">
import { createChordClientConnection, parseDesktopHostAction } from ${literal(input.bridgeUrl)};
import { mount } from ${literal(input.frontendUrl)};
const connectionId = ${literal(input.connectionId)};
let connected = false;
window.addEventListener('message', async (event) => {
  if (connected || event.source !== parent || event.data?.type !== 'pi-gui:extension-connect' || event.data.connectionId !== connectionId || event.ports.length !== 1) return;
  connected = true;
  const port = event.ports[0];
  const root = document.getElementById('root');
  const pending = new Map();
  const theme = event.data.theme;
  const applyTheme = (next) => {
    Object.assign(theme,next);
    document.documentElement.style.colorScheme = theme.mode;
    for (const name of ['background','foreground','accent']) document.documentElement.style.setProperty('--' + name,theme[name]);
  };
  let sequence = 0;
  let dispose;
  const showError = (error) => {
    root.className = 'host-error';
    root.textContent = error instanceof Error ? error.message : String(error);
    port.postMessage({type:'pi-gui:frame-error',message:root.textContent});
  };
  const connection = createChordClientConnection({send: message => port.postMessage(message),onError:showError});
  const action = (input) => new Promise((resolve,reject) => {
    if (connection.signal.aborted) { reject(new Error('This view is closed')); return; }
    if (pending.size >= 32) { reject(new Error('Too many pending desktop actions')); return; }
    let value;
    try { value = parseDesktopHostAction(input); } catch (error) { reject(error); return; }
    const requestId = 'host-' + (++sequence);
    pending.set(requestId,{resolve,reject});
    port.postMessage({type:'host-action',requestId,action:value});
  });
  connection.signal.addEventListener('abort', () => {
    for (const request of pending.values()) request.reject(new Error('This view is closed'));
    pending.clear();
    if (dispose) Promise.resolve().then(dispose).catch(showError);
  }, {once:true});
  port.onmessage = ({data}) => {
    if (data?.type === 'pi-gui:theme-changed') { applyTheme(data.theme); return; }
    if (data?.type === 'host-action-result') {
      const request = pending.get(data.requestId);
      if (!request) return;
      pending.delete(data.requestId);
      if (data.ok === true) request.resolve();
      else request.reject(new Error(typeof data.error === 'string' ? data.error : 'The action could not be completed'));
    } else connection.receive(data);
  };
  port.onmessageerror = () => connection.close('Invalid frame message');
  port.start();
  applyTheme(theme);
  try {
    if (typeof mount !== 'function') throw new Error('The extension frontend must export mount(root, host).');
    dispose = await mount(root,{services:connection.services,signal:connection.signal,theme,actions:{
      openFile: target => action({type:'openFile',...target}),
      prepareTaskDraft: draft => action({type:'prepareTaskDraft',...draft})
    }});
    if (typeof dispose !== 'function') throw new Error('The extension mount must return a cleanup function.');
    if (connection.signal.aborted) await dispose();
    else port.postMessage({type:'pi-gui:frame-ready'});
  } catch (error) { showError(error); connection.close('Extension mount failed'); }
}, {once:false});
</script></body></html>`;
}
