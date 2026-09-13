/**
 * Shared light/dark theme toggle for the demo pages.
 *
 * Purely cosmetic — reads/writes one localStorage key and flips a
 * `data-theme` attribute on <html>. Falls back quietly (and to the OS
 * preference via CSS) if storage is unavailable.
 */
(function () {
  'use strict';

  var KEY = 'solitics_theme';
  var root = document.documentElement;

  function stored() {
    try {
      return window.localStorage.getItem(KEY);
    } catch (error) {
      return null;
    }
  }

  function apply(mode) {
    if (mode === 'light' || mode === 'dark') {
      root.setAttribute('data-theme', mode);
    } else {
      root.removeAttribute('data-theme');
    }
  }

  function current() {
    var explicit = root.getAttribute('data-theme');
    if (explicit) return explicit;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  apply(stored());

  function wire(button) {
    if (!button) return;
    var render = function () {
      var mode = current();
      button.setAttribute('aria-label', mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
      button.classList.toggle('is-dark', mode === 'dark');
    };
    render();
    button.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      apply(next);
      try {
        window.localStorage.setItem(KEY, next);
      } catch (error) {
        /* ignore */
      }
      render();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-theme-toggle]').forEach(wire);
  });
})();
