// Small helper shared by the member dashboard and the leaders area.
// CBC_YT.id(url) returns the 11 character YouTube video id for the usual link shapes,
// or "" if the link is not a YouTube video. Only that id ever reaches the player address.
(function () {
  var HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be"];
  var ID = /^[A-Za-z0-9_-]{11}$/;

  function id(link) {
    var u;
    try {
      u = new URL(String(link || "").trim());
    } catch (_) {
      return "";
    }
    if (u.protocol !== "https:" || HOSTS.indexOf(u.hostname.toLowerCase()) === -1) return "";
    var parts = u.pathname.split("/").filter(Boolean);
    var found = "";
    if (u.hostname.toLowerCase() === "youtu.be") found = parts[0] || "";
    else if (parts[0] === "watch") found = u.searchParams.get("v") || "";
    else if (["live", "embed", "shorts", "v"].indexOf(parts[0]) !== -1) found = parts[1] || "";
    return ID.test(found) ? found : "";
  }

  function isYouTubeHost(link) {
    try {
      return HOSTS.indexOf(new URL(String(link || "").trim()).hostname.toLowerCase()) !== -1;
    } catch (_) {
      return false;
    }
  }

  window.CBC_YT = { id: id, isYouTubeHost: isYouTubeHost };
})();
