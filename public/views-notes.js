/* ============================================================================
   e360 SHOWRUNNER — NOTES + @MENTIONS (notes pass)
   ----------------------------------------------------------------------------
   ONE thread component, mounted everywhere threads live: show Overview, task
   cards, the file viewer meta panel, PO + job drill-ins, and the season
   dashboard. Plus the bell — the personal inbox of mentions/replies and
   agent activity, in a topbar popover (the roster-pop pattern).

   SAFETY: note bodies are esc()'d FIRST, then mention-chipped — the chip
   regex runs on already-escaped text and only ever wraps [A-Za-z0-9_] runs,
   so no HTML can ride in through a body or a mention lookalike.
   ========================================================================== */

/* UI state that survives re-renders (views re-render wholesale on mutation) */
var NOTES_UI = { openSteps: {}, expanded: {}, replyTo: null, editing: null };

/* ---------------- tiny formatters ---------------- */
function fmtAgo(ts) {
  if (!ts) return '';
  var d = new Date(ts.length > 10 ? ts : ts + 'T00:00:00');
  if (isNaN(d)) return '';
  var mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return mins + 'm';
  var h = Math.round(mins / 60);
  if (h < 24) return h + 'h';
  var days = Math.round(h / 24);
  if (days < 8) return days + 'd';
  return fmtDate(ts);
}

/* escape FIRST, chip mentions SECOND — see safety note above */
function renderNoteBody(body) {
  var lk = mentionLookup();
  return esc(body).replace(/@([A-Za-z][A-Za-z0-9_]*)/g, function (m, tok) {
    var u = lk[tok.toLowerCase()];
    if (!u) return m;
    return '<span class="mention">@' + esc(firstName(u)) + '</span>';
  });
}

/* humans get their roster avatar; agents get the bolt mark */
function noteAvatar(author) {
  if (String(author).indexOf('agent:') === 0) {
    return '<span class="agent-av" title="' + esc(actorName(author)) + '">' + icon('bolt') + '</span>';
  }
  return av(author) || '<span class="avatar" style="background:var(--surface-3);color:var(--text-2)">?</span>';
}

/* ---------------- one note row ---------------- */
function noteHTML(n, canReply) {
  if (NOTES_UI.editing === n.id) {
    return '<div class="note" data-note-id="' + n.id + '">' + noteAvatar(n.author) +
      '<div class="nb"><textarea class="note-in note-edit-in" data-note="' + n.id + '" rows="2">' + esc(n.body) + '</textarea>' +
      '<div class="nc-row" style="display:flex"><span class="nc-hint">Editing — mentions re-parse on save</span>' +
      '<button class="btn sm ghost" ' + act('noteEditCancel', n.id) + '>Cancel</button>' +
      '<button class="btn sm primary" ' + act('noteEditSave', n.id) + '>Save</button></div></div></div>';
  }
  var edited = n.edited_at ? '<span class="n-edited" title="edited ' + esc(fmtTs(n.edited_at)) + '">· edited</span>' : '';
  var acts = [];
  if (canReply) acts.push('<button class="n-act" ' + act('noteReply', n.id) + '>' + inlineIcon('chat') + 'Reply</button>');
  if (n.author === ME) acts.push('<button class="n-act" ' + act('noteEdit', n.id) + '>' + inlineIcon('pencil') + 'Edit</button>');
  return '<div class="note' + (String(n.author).indexOf('agent:') === 0 ? ' agent' : '') + '" data-note-id="' + n.id + '">' +
    noteAvatar(n.author) +
    '<div class="nb"><div class="nh"><b>' + esc(actorName(n.author)) + '</b>' +
    (n.provenance ? provBadge(n.provenance) : '') +
    '<span class="nt" title="' + esc(fmtTs(n.created_at)) + '">' + esc(fmtAgo(n.created_at)) + '</span>' + edited + '</div>' +
    '<div class="ntx">' + renderNoteBody(n.body) + '</div>' +
    (acts.length ? '<div class="n-acts">' + acts.join('') + '</div>' : '') +
    '</div></div>';
}

/* ---------------- composer ---------------- */
function noteComposer(anchorType, anchorId, parentId) {
  return '<div class="note-composer" data-anchor-type="' + esc(anchorType) + '" data-anchor-id="' + Number(anchorId) + '"' +
    (parentId ? ' data-parent="' + Number(parentId) + '"' : ' data-parent=""') + '>' +
    '<textarea class="note-in" rows="1" placeholder="' + (parentId ? 'Reply — @ to mention' : 'Add a note — @ to mention') + '"></textarea>' +
    '<div class="nc-row"><span class="nc-hint">@ mentions land in their inbox · Ctrl/⌘ + Enter posts</span>' +
    '<button class="btn sm primary" ' + act('notePost') + '>' + icon('send') + 'Post</button></div></div>';
}

/* ---------------- THE thread component ----------------
   opts.collapse = N -> show only the latest N thread roots until expanded */
function notesThread(anchorType, anchorId, opts) {
  opts = opts || {};
  var threads = notesFor(anchorType, anchorId);
  var key = anchorType + ':' + anchorId;
  var hidden = 0;
  if (opts.collapse && !NOTES_UI.expanded[key] && threads.length > opts.collapse) {
    hidden = threads.length - opts.collapse;
    threads = threads.slice(-opts.collapse);
  }
  var more = hidden
    ? '<button class="n-more" ' + act('noteExpand', null, key) + '>' + inlineIcon('chevD') + ' Show ' + hidden + ' earlier thread' + (hidden === 1 ? '' : 's') + '</button>'
    : '';
  var body = threads.map(function (t) {
    var replies = t.replies.map(function (r) { return noteHTML(r, false); }).join('');
    var replyBox = NOTES_UI.replyTo === t.root.id ? noteComposer(anchorType, anchorId, t.root.id) : '';
    return '<div class="note-th">' + noteHTML(t.root, true) +
      (replies || replyBox ? '<div class="note-replies">' + replies + replyBox + '</div>' : '') + '</div>';
  }).join('');
  return '<div class="note-thread">' + more +
    (body || '<div class="notes-empty">No notes yet — start the thread.</div>') +
    noteComposer(anchorType, anchorId, null) + '</div>';
}
function notesPanel(anchorType, anchorId, opts) {
  opts = opts || {};
  var count = noteCount(anchorType, anchorId);
  return '<div class="panel"><h3>' + esc(opts.title || 'Notes') + (count ? ' · ' + count : '') + '</h3>' +
    notesThread(anchorType, anchorId, opts) + '</div>';
}

/* flash-highlight one note after a deep-link render */
function flashNote(noteId) {
  setTimeout(function () {
    var el2 = document.querySelector('[data-note-id="' + Number(noteId) + '"]');
    if (!el2 || !el2.classList) return;
    el2.classList.add('note-flash');
    if (el2.scrollIntoView) el2.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(function () { if (el2.classList) el2.classList.remove('note-flash'); }, 2100);
  }, 80);
}

/* ============================================================================
   THE BELL — personal inbox popover. Two sections: mentions & replies from
   people, and agent activity needing a human (agent-authored notes @ing me +
   my agent's pending proposals, reusing the finance feedItem confirm/reject).
   ========================================================================== */
function inboxItemHTML(x) {
  var n = x.note, a = x.anchor || {};
  /* a notify-picker delivery: the whole sentence lives in the note body —
     "Tom assigned you: Power plan — LOVB Madison — Match 1". Clicking it
     deep-links to the anchored thing, exactly like a mention. */
  if (x.reason === 'notify') {
    return '<button class="ib-item' + (x.read ? '' : ' unread') + '" ' + act('openNote', n.id) + '>' +
      noteAvatar(n.author) +
      '<div class="ib-tx"><div class="ib-l"><b>' + esc(actorName(n.author)) + '</b> ' + esc(n.body) + '</div></div>' +
      '<span class="ib-t">' + esc(fmtAgo(n.created_at)) + '</span>' +
      (x.read ? '' : '<span class="ib-dot"></span>') + '</button>';
  }
  var verb = x.reason === 'mention' ? 'mentioned you'
    : x.reason === 'reply' ? 'replied to your note'
    : 'added to a thread you’re in';
  return '<button class="ib-item' + (x.read ? '' : ' unread') + '" ' + act('openNote', n.id) + '>' +
    noteAvatar(n.author) +
    '<div class="ib-tx"><div class="ib-l"><b>' + esc(actorName(n.author)) + '</b> ' + verb +
    ' <span class="ib-on">· ' + esc(a.label || '') + '</span></div>' +
    '<div class="ib-body">' + renderNoteBody(n.body) + '</div></div>' +
    '<span class="ib-t">' + esc(fmtAgo(n.created_at)) + '</span>' +
    (x.read ? '' : '<span class="ib-dot"></span>') + '</button>';
}

/* `d` is {items, proposals, recaps} — the seam's answer. Omitted (demo mode,
   or a re-render before the fetch lands) it falls back to the mock store,
   which is where the demo's inbox lives. */
function renderInbox(d) {
  var items = d ? (d.items || []) : noteInbox(ME);
  var human = [], agent = [];
  items.forEach(function (x) { (String(x.note.author).indexOf('agent:') === 0 ? agent : human).push(x); });
  var props = d ? (d.proposals || []) : proposalsForUser(ME);
  /* recap pass: a draft client recap needs the person who can approve it —
     same section, same "an agent did something, a human decides" shape */
  var recaps = d ? (d.recaps || []) : recapsAwaitingReview(ME);
  var unread = items.filter(function (x) { return !x.read; }).length;
  var head = '<div class="bp-h"><b>Inbox</b>' +
    (unread ? '<span class="pill acc" style="padding:1px 8px;font-size:10px"><span class="dot"></span>' + unread + ' unread</span>' : '') +
    (unread ? '<button class="btn sm ghost" ' + act('bellMarkAll') + '>Mark all read</button>' : '') + '</div>';
  if (!items.length && !props.length && !recaps.length) {
    return head + '<div class="bp-empty">' + icon('checkC') + '<b>All caught up</b>' +
      '<span>@mentions, replies and agent activity land here — each anchored to the thing it’s about.</span></div>';
  }
  var CAP = 8;
  var rows = human.slice(0, CAP).map(inboxItemHTML).join('') ||
    '<div class="notes-empty" style="padding:8px 2px 4px">No mentions yet — teammates @you on the thing itself.</div>';
  var earlier = human.length > CAP ? '<div class="perm-note" style="margin-top:6px">+' + (human.length - CAP) + ' earlier</div>' : '';
  var out = head + '<div class="bp-sec">Mentions &amp; replies</div>' + rows + earlier;
  if (agent.length || props.length || recaps.length) {
    out += '<div class="bp-sec">Agent activity needing you</div>' +
      recaps.map(recapReviewRow).join('') +          /* recap pass — draft-first */
      agent.map(inboxItemHTML).join('') +
      props.map(function (f) {
        /* photo proposals get their own row (photo pass) — thumb, not money */
        if (f.kind === 'photo') return photoProposalRow(f);
        return feedItem({ type: 'doc', ts: f.created_at, id: f.id, file: f, show: SHOWS_BY_ID[f.show_id] });
      }).join('');
  }
  return out;
}

/* one fetch pair, shared by the panel and its refresh */
async function inboxData() {
  var r = await api.myInbox();
  var recaps = await api.recapsAwaitingReview();
  return { items: r.items || [], proposals: r.proposals || [], recaps: recaps || [] };
}

async function toggleBellPanel(anchor) {
  if (document.getElementById('bellPop')) { closeBellPanel(); return; }
  var pop = document.createElement('div');
  pop.className = 'bell-pop'; pop.id = 'bellPop';
  pop.innerHTML = '<div class="bp-h"><b>Inbox</b></div><div class="bp-empty">' + icon('bell') + '<b>Loading…</b></div>';
  document.body.appendChild(pop);
  try {
    var rc = anchor.getBoundingClientRect(), vw = window.innerWidth || 1200;
    var left = Math.min(rc.right - 384, vw - 396);
    if (left < 8) left = 8;
    pop.style.left = left + 'px';
    pop.style.top = (rc.bottom + 8) + 'px';
  } catch (_) { pop.style.right = '20px'; pop.style.top = '64px'; }
  /* navigating out of the panel (View on a proposal) should dismiss it */
  pop.addEventListener('click', function (ev) {
    var t2 = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (t2 && t2.getAttribute('data-act') === 'openViewer') closeBellPanel();
  });
  setTimeout(function () { document.addEventListener('mousedown', bellOutside); }, 0);
  return refreshBellPanel();
}
function bellOutside(ev) {
  var p = document.getElementById('bellPop'), bell = document.getElementById('bellBtn');
  if (p && !p.contains(ev.target) && !(bell && bell.contains && bell.contains(ev.target))) closeBellPanel();
}
function closeBellPanel() {
  var p = document.getElementById('bellPop');
  if (p) p.remove();
  document.removeEventListener('mousedown', bellOutside);
}
async function refreshBellPanel() {
  if (!document.getElementById('bellPop')) return;
  var d;
  try { d = await inboxData(); } catch (_) { return; }
  var p = document.getElementById('bellPop');   /* it may have closed mid-fetch */
  if (p) p.innerHTML = renderInbox(d);
}
async function updateBellBadge() {
  var b = document.getElementById('bellBadge');
  if (!b) return;
  var n;
  try { n = (await api.notesUnreadCount()).badge; } catch (_) { return; }
  b.textContent = n > 9 ? '9+' : String(n);
  b.style.display = n ? '' : 'none';
}

/* ============================================================================
   @AUTOCOMPLETE — roster popover over any .note-in textarea
   ========================================================================== */
var MENTION_POP = null;
function closeMentionPop() {
  if (MENTION_POP) { if (MENTION_POP.el.remove) MENTION_POP.el.remove(); MENTION_POP = null; }
}
function mentionToken(ta) {
  var v = ta.value || '';
  var pos = ta.selectionStart == null ? v.length : ta.selectionStart;
  var m = /(^|[\s(])@([A-Za-z]*)$/.exec(v.slice(0, pos));
  return m ? { start: pos - m[2].length - 1, token: m[2], pos: pos } : null;
}
function mentionMatches(token) {
  var t = String(token).toLowerCase();
  /* the server's mention resolver already refuses inactive usernames
     (lib/mentions.js), so offering one here would be a suggestion that
     silently fails to notify anybody */
  return activeUsers().filter(function (u) {
    return u.name.split(' ')[0].toLowerCase().indexOf(t) === 0 || u.username.toLowerCase().indexOf(t) === 0;
  });
}
function paintMentionSel() {
  if (!MENTION_POP) return;
  var opts = MENTION_POP.el.querySelectorAll('.rp-opt');
  for (var i = 0; i < opts.length; i++) opts[i].classList.toggle('on', i === MENTION_POP.idx);
}
function openMentionPop(ta) {
  var tk = mentionToken(ta);
  if (!tk) { closeMentionPop(); return; }
  var matches = mentionMatches(tk.token);
  if (!matches.length) { closeMentionPop(); return; }
  closeMentionPop();
  var el2 = document.createElement('div');
  el2.className = 'roster-pop mention-pop';
  el2.innerHTML = '<div class="rp-h">Mention · pings their inbox</div>' + matches.map(function (u, i) {
    return '<button class="rp-opt' + (i === 0 ? ' on' : '') + '" data-mention="' + esc(u.username) + '">' + av(u.username) +
      '<span class="ri2"><span class="rn">' + esc(u.name) + '</span><span class="rr">' + esc(roleName(u.role) + ' · ' + u.title) + '</span></span></button>';
  }).join('');
  document.body.appendChild(el2);
  try {
    var rc = ta.getBoundingClientRect(), vh = window.innerHeight || 800;
    var top = rc.bottom + 4;
    if (top + 270 > vh) top = Math.max(8, rc.top - 274);
    el2.style.left = rc.left + 'px';
    el2.style.top = top + 'px';
  } catch (_) {}
  MENTION_POP = { el: el2, ta: ta, matches: matches, idx: 0, tk: tk };
  el2.addEventListener('mousedown', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-mention]') : null;
    if (!b) return;
    ev.preventDefault();
    insertMention(ROSTER[b.getAttribute('data-mention')]);
  });
}
function insertMention(u) {
  if (!MENTION_POP || !u) return;
  var ta = MENTION_POP.ta;
  var tk = mentionToken(ta) || MENTION_POP.tk;
  var name = u.name.split(' ')[0];
  ta.value = ta.value.slice(0, tk.start) + '@' + name + ' ' + ta.value.slice(tk.pos);
  var np = tk.start + name.length + 2;
  try { ta.setSelectionRange(np, np); } catch (_) {}
  closeMentionPop();
  if (ta.focus) ta.focus();
}

/* composer listeners — document-level, so re-rendered composers keep working */
document.addEventListener('input', function (ev) {
  var t = ev.target;
  if (t && t.classList && t.classList.contains('note-in')) openMentionPop(t);
});
document.addEventListener('mousedown', function (ev) {
  if (MENTION_POP && !MENTION_POP.el.contains(ev.target) && ev.target !== MENTION_POP.ta) closeMentionPop();
});
document.addEventListener('keydown', function (ev) {
  var t = ev.target;
  if (!t || !t.classList || !t.classList.contains('note-in')) return;
  if (MENTION_POP && MENTION_POP.ta === t) {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault(); ev.stopPropagation();
      var d = ev.key === 'ArrowDown' ? 1 : -1, n = MENTION_POP.matches.length;
      MENTION_POP.idx = (MENTION_POP.idx + d + n) % n;
      paintMentionSel();
      return;
    }
    if ((ev.key === 'Enter' || ev.key === 'Tab') && !(ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault(); ev.stopPropagation();
      insertMention(MENTION_POP.matches[MENTION_POP.idx]);
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault(); ev.stopPropagation();
      closeMentionPop();
      return;
    }
  }
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
    ev.preventDefault(); ev.stopPropagation();
    postNoteFrom(t);                       /* app.js — resolves the composer */
  }
}, true);
