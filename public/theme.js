// SPDX-License-Identifier: GPL-3.0-or-later
// Applied synchronously in <head> to avoid a flash of the wrong theme.
// Stored values: "light" | "dark"; absent means follow the OS.
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* storage unavailable */ }
})();
