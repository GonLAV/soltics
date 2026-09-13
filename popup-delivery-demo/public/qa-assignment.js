/**
 * QA Assignment page — sidebar navigation with scroll-spy.
 */
(function () {
  'use strict';

  var navItems = document.querySelectorAll('.qa-nav__item');
  var sections = [];
  var navMap = {};

  navItems.forEach(function (item) {
    var href = item.getAttribute('href');
    if (!href || !href.startsWith('#')) return;
    var section = document.querySelector(href);
    if (section) {
      sections.push(section);
      navMap[href] = item;
    }
  });

  function updateActive() {
    var scrollY = window.scrollY + 140;
    var current = sections[0];

    for (var i = 0; i < sections.length; i++) {
      if (sections[i].offsetTop <= scrollY) {
        current = sections[i];
      }
    }

    if (current) {
      navItems.forEach(function (item) { item.classList.remove('active'); });
      var active = navMap['#' + current.id];
      if (active) active.classList.add('active');
    }
  }

  // Smooth scroll on nav click
  navItems.forEach(function (item) {
    item.addEventListener('click', function (e) {
      var href = item.getAttribute('href');
      if (!href || !href.startsWith('#')) return;
      e.preventDefault();
      var target = document.querySelector(href);
      if (target) {
        var offset = target.offsetTop - 120;
        window.scrollTo({ top: offset, behavior: 'smooth' });
      }
    });
  });

  var ticking = false;
  window.addEventListener('scroll', function () {
    if (!ticking) {
      requestAnimationFrame(function () {
        updateActive();
        ticking = false;
      });
      ticking = true;
    }
  });

  updateActive();
})();
