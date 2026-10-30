// Die frühere Pulse-Oberfläche ist im ChatLine Hub aufgegangen.
// Alte Lesezeichen behalten ihr Ziel; /api/data und /api/refresh bleiben unverändert hier.
(function () {
  var HUB = 'https://chatline-social-dashboard.vercel.app/';
  var MAP = { overview: '', facebook: 'anzeigen', website: 'website', funnel: 'website', tracking: 'quellen' };
  var key = String(location.hash || '').replace(/^#\/?/, '').split(/[?/]/)[0];
  var target = HUB + '#/' + (Object.prototype.hasOwnProperty.call(MAP, key) ? MAP[key] : 'anzeigen');
  var link = document.getElementById('hub-link');
  if (link) link.href = target;
  location.replace(target);
})();
