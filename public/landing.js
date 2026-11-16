/*
 * Copyright Mor3 Inc., 2026 All Rights Reserved.
 */

'use strict';

(function () {
    // Header shadow on scroll.
    const header = document.querySelector('.header');
    const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 100);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // Live numbers from the CRM. The secure session cookie is sent automatically.
    const note = document.getElementById('portalStatsNote');
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

    function showSignIn() {
        note.textContent = '';
        const link = document.createElement('a');
        link.href = 'index.html';
        link.textContent = 'Sign in to CRaM';
        note.append(link, ' to see live numbers.');
    }

    fetch('/api/dashboard', { credentials: 'same-origin' })
        .then((res) => {
            if (res.status === 401) throw new Error('signin');
            if (!res.ok) throw new Error('server');
            return res.json();
        })
        .then((data) => {
            const s = data.stats;
            document.getElementById('portalCustomers').textContent = s.totalCustomers.toLocaleString();
            document.getElementById('portalDeals').textContent = s.openDeals.toLocaleString();
            document.getElementById('portalPipeline').textContent = money.format(s.pipelineValue);
            document.getElementById('portalWon').textContent = money.format(s.wonValue);
            note.textContent = 'Live from CRaM.';
        })
        .catch((err) => {
            if (err.message === 'signin') showSignIn();
            else note.textContent = 'Live numbers are unavailable right now.';
        });
})();

/*
 * Copyright Mor3 Inc., 2026 All Rights Reserved.
 */
