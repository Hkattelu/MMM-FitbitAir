/*
 * MMM-FitbitAir re-auth bookmarklet (readable source).
 *
 * Google requires a "Web Server" OAuth client for the googlehealth.* scopes,
 * and a home MagicMirror can't host a public HTTPS callback -- so the
 * registered redirect URI is https://www.google.com and the authorization
 * code lands in that page's query string. Running this from that page hands
 * the code to the mirror without any manual copying.
 *
 * Replace MIRROR_HOST and MIRROR_PORT, then save the minified one-liner in
 * README.md as a bookmark. See the README for setup instructions.
 */

(function () {
  var MIRROR_HOST = "192.168.1.187";
  var MIRROR_PORT = 8091;

  var code = new URLSearchParams(window.location.search).get("code");

  if (!code) {
    alert(
      "No authorization code found on this page.\n\nRun this bookmarklet on the google.com page you land on right after approving access."
    );
    return;
  }

  window.location.href =
    "http://" + MIRROR_HOST + ":" + MIRROR_PORT + "/submit?code=" +
    encodeURIComponent(code);
})();
