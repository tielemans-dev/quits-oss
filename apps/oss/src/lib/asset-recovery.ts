/**
 * Reloads a page whose built files are gone. A deploy replaces every hashed file under `/assets/`,
 * and while it rolls out a page can still get HTML from the old version and then miss that
 * version's files. The router reloads once when a route's chunk is missing, but if the reloaded
 * HTML is old too, its entry script fails and the page stays on its server-rendered placeholder
 * until someone reloads by hand. This reloads again a little later, a few times.
 *
 * It only acts until the app has started (`markAppStarted`): later failures, such as a lazily
 * loaded dialog after a deploy, must not reload a page that may hold unsaved input.
 *
 * It runs inline in the document head, before the entry loads. It is a string, not a function's
 * source, so the server and the minified client render the same script and hydration matches.
 */
const RELOAD_KEY = "quits-asset-reload"
const STARTED_ATTRIBUTE = "data-app-started"
// After the first failure, reload after each delay in turn; then stop, so a file that is gone for
// good cannot keep the page reloading. Attempts older than the window no longer count.
const RELOAD_DELAYS_MS = [1000, 2000, 5000, 10000]
const RELOAD_WINDOW_MS = 120000

/** The script's body as a function of `win`, so tests can run it against a fake window. */
export const assetRecoverySource = `function(win){
var key=${JSON.stringify(RELOAD_KEY)},delays=${JSON.stringify(RELOAD_DELAYS_MS)},windowMs=${RELOAD_WINDOW_MS},pending=false;
function isAsset(url){if(typeof url!=="string"||!url)return false;try{var u=new URL(url,win.location.href);return u.origin===win.location.origin&&u.pathname.indexOf("/assets/")===0}catch(e){return false}}
function reloadLater(){var root=win.document&&win.document.documentElement;if(pending||(root&&root.hasAttribute(${JSON.stringify(STARTED_ATTRIBUTE)})))return;var now=Date.now(),s=null;try{s=JSON.parse(win.sessionStorage.getItem(key)||"null")}catch(e){}
if(!s||typeof s.at!=="number"||typeof s.count!=="number"||now-s.at>windowMs)s={at:now,count:0};if(s.count>=delays.length)return;
var delay=delays[s.count];s.count+=1;try{win.sessionStorage.setItem(key,JSON.stringify(s))}catch(e){return}
pending=true;win.setTimeout(function(){win.location.reload()},delay)}
win.addEventListener("error",function(e){var t=e.target;if(t&&t!==win&&(isAsset(t.src)||isAsset(t.href)))reloadLater()},true);
win.addEventListener("unhandledrejection",function(e){var r=e.reason,m=String(r&&typeof r==="object"?r.message:r),
f=/(?:dynamically imported module|module script failed)[:.]?\\s*(\\S*)/i.exec(m);if(f&&(!f[1]||isAsset(f[1])))reloadLater()})
}`
// Above: a missing script, stylesheet, preload or font fires an `error` that does not bubble, so it
// listens on capture. The entry is loaded with an inline `import()`, so a missing entry is an
// unhandled rejection; Chrome and Firefox name the file, Safari does not. Without storage the
// attempts cannot be counted, so it does not reload at all.

/** The inline head script. Keep it before the app's scripts, so it sees their failures. */
export const assetRecoveryScript = `(${assetRecoverySource})(window)`

/** Called once the app has hydrated: from now on failures are the app's to handle. */
export function markAppStarted() {
  document.documentElement.setAttribute(STARTED_ATTRIBUTE, "")
  // The next deploy gets every attempt again.
  try {
    window.sessionStorage.removeItem(RELOAD_KEY)
  } catch {
    // Without storage there is no count to clear.
  }
}
