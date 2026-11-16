/*
 * Copyright Mor3 Inc., 2026 All Rights Reserved.
 */

/*
 * Branding — change the name here once and it updates everywhere
 * (page titles, logos, sign-in screen, portal).
 */
window.APP_CONFIG = {
    appName: 'CRaM',
    portalName: 'CRaM Team Portal',
    tagline: 'Computations, Resolutions, and Management',
};

document.addEventListener('DOMContentLoaded', function () {
    var cfg = window.APP_CONFIG;
    var isPortal = document.body.hasAttribute('data-portal');
    var name = isPortal ? cfg.portalName : cfg.appName;
    document.title = name;
    document.querySelectorAll('[data-brand]').forEach(function (el) {
        el.textContent = el.getAttribute('data-brand') === 'app' ? cfg.appName : name;
    });
});

/*
 * Copyright Mor3 Inc., 2026 All Rights Reserved.
 */
