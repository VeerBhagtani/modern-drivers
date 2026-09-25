/* Modern Drivers dashboard — sign-in and bootstrap.
 *
 * The office signs in with a username and password held by this product's own
 * backend. No Google account, no Firebase, nothing shared with any other
 * system: one admin user is created at setup and that is the whole identity
 * story.
 *
 * The token lives in sessionStorage, so closing the tab signs you out. A screen
 * showing forty people's live positions should not stay open on an office PC
 * overnight.
 */
(function () {
  'use strict';

  var KEY = 'md_admin_session';
  var el = function (id) { return document.getElementById(id); };

  var session = null;
  try {
    session = JSON.parse(sessionStorage.getItem(KEY) || 'null');
  } catch (e) { session = null; }

  // The API layer asks for this on every request.
  window.DRIVERS_AUTH = {
    getToken: function () {
      if (!session || !session.token) return Promise.reject(new Error('Not signed in.'));
      return Promise.resolve(session.token);
    },
    admin: function () { return session && session.admin; },
    signOut: signOut,
  };

  function signOut() {
    session = null;
    try { sessionStorage.removeItem(KEY); } catch (e) { /* private window */ }
    showLogin();
  }
  // An expired or rejected token anywhere in the app lands back here.
  window.DRIVERS_SIGNOUT = signOut;

  function showLogin(message) {
    el('login').hidden = false;
    el('app').hidden = true;
    var err = el('loginErr');
    err.hidden = !message;
    err.textContent = message || '';
    // The server address is asked for only when the dashboard does not already
    // know one, so day to day this is a two-field sign-in.
    var known = !!window.DRIVERS_API.base;
    el('serverField').hidden = known;
    el('btnServer').hidden = !known;
    if (known) el('apiBase').value = window.DRIVERS_API.base;
    var u = el(known ? 'username' : 'apiBase');
    if (u) u.focus();
  }

  function showApp() {
    el('login').hidden = true;
    el('app').hidden = false;
    var who = el('whoami');
    if (who && session && session.admin) {
      who.textContent = session.admin.name + ' · ' + session.admin.role;
    }
    if (!window.DRIVERS_API.base) {
      el('tabs').innerHTML = '';
      el('view').innerHTML = '<div class="card"><p class="err">This dashboard has no server address yet.</p>'
        + '<p class="muted">Sign out and enter it on the sign-in screen. '
        + 'Nothing will load until then — the dashboard will not invent numbers to fill the screen.</p></div>';
      return;
    }
    window.DRIVERS_VIEWS.renderTabs();
    window.DRIVERS_VIEWS.render();
    if (session && session.admin && session.admin.mustChangePassword) {
      window.DRIVERS_PASSWORD_DIALOG(true);
    }
  }

  function signIn() {
    var username = el('username').value.trim();
    var password = el('password').value;
    var btn = el('btnLogin');
    var err = el('loginErr');
    err.hidden = true;
    if (!username || !password) {
      err.textContent = 'Enter your username and password.';
      err.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    var base;
    try {
      base = window.DRIVERS_API.setBase(el('apiBase').value || window.DRIVERS_API.base);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Sign in';
      return;
    }
    if (!base) {
      err.textContent = 'Enter the server address first.';
      err.hidden = false;
      el('serverField').hidden = false;
      el('apiBase').focus();
      btn.disabled = false;
      btn.textContent = 'Sign in';
      return;
    }

    fetch(base + '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password }),
    })
      .then(function (r) { return r.json().catch(function () { return { success: false, message: 'Server error ' + r.status }; }); })
      .then(function (j) {
        if (!j || !j.success) throw new Error((j && j.message) || 'Sign-in failed.');
        session = { token: j.data.token, admin: j.data.admin };
        try { sessionStorage.setItem(KEY, JSON.stringify(session)); } catch (e) { /* private window */ }
        el('password').value = '';
        showApp();
      })
      .catch(function (e) {
        // "Failed to fetch" is all the browser will say for a blocked request,
        // and on its own it sends people looking at the server when the server
        // is fine. Naming the address it tried turns an hour of guessing into a
        // glance — a wrong or stale address is by far the most common cause,
        // and it is invisible until you print it.
        err.textContent = e.message === 'Failed to fetch'
          ? 'Could not reach ' + base + ' from this browser. '
            + 'Either that address is wrong, or the server is not allowing this site to call it.'
          : e.message;
        err.hidden = false;
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Sign in';
      });
  }

  el('btnLogin').addEventListener('click', signIn);
  el('btnServer').addEventListener('click', function () {
    el('serverField').hidden = false;
    el('btnServer').hidden = true;
    el('apiBase').focus();
  });
  el('apiBase').addEventListener('keydown', function (e) { if (e.key === 'Enter') el('username').focus(); });
  el('password').addEventListener('keydown', function (e) { if (e.key === 'Enter') signIn(); });
  el('username').addEventListener('keydown', function (e) { if (e.key === 'Enter') el('password').focus(); });
  el('btnSignout').addEventListener('click', signOut);

  // Changing your own password, in the browser. The seeded account arrives with
  // a password the office did not choose, and one that was generated elsewhere
  // is not a secret the office keeps — so the banner stays up until it is
  // replaced.
  function passwordDialog(forced) {
    var bg = el('modalBg');
    el('modal').innerHTML = ''
      + '<h2 style="margin:0 0 6px;font-size:1.2rem">Change your password</h2>'
      + '<p class="muted" style="margin:0 0 18px">'
      + (forced
        ? 'This account is still using the password it was set up with. Choose your own.'
        : 'At least 10 characters.')
      + '</p>'
      + '<div class="field"><label for="pwOld">Current password</label>'
      + '<input id="pwOld" type="password" autocomplete="current-password"></div>'
      + '<div class="field"><label for="pwNew">New password</label>'
      + '<input id="pwNew" type="password" autocomplete="new-password"></div>'
      + '<div class="field"><label for="pwNew2">New password again</label>'
      + '<input id="pwNew2" type="password" autocomplete="new-password"></div>'
      + '<p id="pwMsg" class="err" hidden></p>'
      + '<div style="display:flex;gap:10px">'
      + '<button id="pwSave" class="btn-primary">Save</button>'
      + (forced ? '' : '<button id="pwCancel" class="btn-outline" style="width:100%">Cancel</button>')
      + '</div>';
    bg.classList.add('on');

    var msg = el('pwMsg');
    function fail(t) { msg.className = 'err'; msg.textContent = t; msg.hidden = false; }

    el('pwSave').addEventListener('click', function () {
      msg.hidden = true;
      var oldPw = el('pwOld').value;
      var a = el('pwNew').value;
      var b = el('pwNew2').value;
      if (a !== b) return fail('The two new passwords do not match.');
      if (a.length < 10) return fail('Use at least 10 characters.');
      var btn = el('pwSave');
      btn.disabled = true; btn.textContent = 'Saving…';
      window.DRIVERS_API.changePassword(oldPw, a)
        .then(function (out) {
          msg.className = 'ok-msg';
          msg.textContent = 'Changed. Use the new password next time you sign in.';
          msg.hidden = false;
          // The server signs out every older session; this one gets a new token.
          if (session && out && out.token) session.token = out.token;
          if (session && session.admin) session.admin.mustChangePassword = false;
          try { sessionStorage.setItem(KEY, JSON.stringify(session)); } catch (e) { /* private window */ }
          setTimeout(function () { bg.classList.remove('on'); showApp(); }, 1200);
        })
        .catch(function (e) { fail(e.message); })
        .then(function () { btn.disabled = false; btn.textContent = 'Save'; });
    });
    var cancel = el('pwCancel');
    if (cancel) cancel.addEventListener('click', function () { bg.classList.remove('on'); });
  }
  el('btnPassword').addEventListener('click', function () { passwordDialog(false); });
  window.DRIVERS_PASSWORD_DIALOG = passwordDialog;

  function tick() {
    var c = el('clock');
    if (c) c.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  setInterval(tick, 1000);
  tick();

  if (session && session.token) showApp(); else showLogin();
})();
