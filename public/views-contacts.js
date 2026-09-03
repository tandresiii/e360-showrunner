/* ============================================================================
   CONTACTS — the rolodex (Tom, 2026-08-27)
   ----------------------------------------------------------------------------
   "there should be a contact rolodex in our app if we dont already have one."
   One card per person or org the company deals with — clients, venues,
   vendors, local crew — searchable, filterable by kind, archived-not-deleted.
   The show's POC fields stay free text; this directory FILLS them (the
   call-sheet picker) and the show↔contact links answer "where is this person
   used" from both ends.

   Rendering rules, same as every other view:
     · pure string builders reading the flat stores, no DOM access
     · esc() on every interpolated value
     · every affordance is a data-act; the ACTIONS map in app.js is the wiring
   ========================================================================== */

/* view state — mutated by ACTIONS, then render('contacts') re-runs the view.
   `q` is the live filter: it narrows what is ALREADY LOADED (same honest
   posture as the topbar search), re-rendering only the table body. */
var CONTACTS_UI = { mode: 'active', kind: '', q: '' };
var CONTACTS_LAST = [];

/* a MAP, not a ternary — a sixth kind cannot silently render as "other"
   (the dealTag rule, components.js) */
var CONTACT_KIND_TAGS = {
  client: ['led',   'Client — who buys the show'],
  venue:  ['print', 'Venue — where it happens'],
  vendor: ['both',  'Vendor — who we buy from'],
  crew:   ['led',   'Crew — local hires and day-of labor'],
  other:  ['',      'Other — worth keeping, hard to file']
};
function contactKindTag(c) {
  var a = CONTACT_KIND_TAGS[c && c.kind];
  if (!a) return '<span class="tag">' + esc(c && c.kind || 'other') + '</span>';
  return '<span class="tag ' + esc(a[0]) + '" title="' + esc(a[1]) + '">' + esc(c.kind) + '</span>';
}

/* the empty-state chip convention from teamEmailCell: a missing address is a
   fact worth stating, not a blank cell */
function contactEmailCell(c) {
  if (!c.email) return '<td><span class="pill idle">no email</span></td>';
  return '<td class="mono" style="font-size:11.5px;word-break:break-all">' +
    '<a href="mailto:' + esc(c.email) + '" style="color:var(--text-2)">' + esc(c.email) + '</a></td>';
}
function contactPhoneCell(c) {
  if (!c.phone) return '<td><span class="pill idle">no phone</span></td>';
  return '<td><a class="btn sm poc-tel" href="' + esc(telHref(c.phone)) + '">' +
    icon('phone') + esc(c.phone) + '</a></td>';
}

function contactRowActions(c) {
  if (!canEditContacts()) return '<td></td>';
  var admin = CURRENT_USER.role === 'admin';
  return '<td class="team-acts">' +
    '<button class="btn sm ghost" ' + act('ctEdit', c.id) + '>' + icon('pencil') + 'Edit</button>' +
    (c.archived_at
      ? '<button class="btn sm ghost" ' + act('ctUnarchive', c.id) + '>' + icon('refresh') + 'Restore</button>'
      : '<button class="btn sm ghost" ' + act('ctArchive', c.id) +
        ' title="Out of the working set, still searchable — the retirement path.">' +
        icon('box') + 'Archive</button>') +
    (admin
      ? '<button class="btn sm ghost" ' + act('ctDelete', c.id) +
        ' title="Admin only — refuses while the contact is on any show.">' + icon('trash') + 'Delete</button>'
      : '') +
    '</td>';
}

function contactRow(c) {
  var linked = c.linked_shows != null ? c.linked_shows : contactLinkCount(c.id);
  return '<tr' + (c.archived_at ? ' class="team-off"' : '') + '>' +
    '<td><button style="padding:0;background:none;border:0;cursor:pointer;text-align:left;color:var(--text);font-family:inherit" ' +
      act('openContact', c.id) + ' title="Open the card — details and every show it is on">' +
      '<span class="ev-name"><span>' +
      '<b>' + esc(c.name) + '</b><span>' + esc(c.title || '') + '</span></span></span></button>' +
      (c.archived_at ? ' ' + archivedChip(c) : '') +
      (c.flex_contact_id
        ? ' <span class="tag" title="Linked to the Flex contact directory — the event-folder create path holds this ref.">flex</span>'
        : '') + '</td>' +
    '<td>' + esc(c.org || '—') + '</td>' +
    '<td>' + contactKindTag(c) + '</td>' +
    contactEmailCell(c) +
    contactPhoneCell(c) +
    '<td class="mono" style="color:var(--text-2)" title="Shows this contact is linked to">' + linked + '</td>' +
    contactRowActions(c) + '</tr>';
}

/* the table body alone — the live search re-renders just this */
function contactRowsHTML() {
  var q = String(CONTACTS_UI.q || '').toLowerCase();
  var rows = CONTACTS_LAST.filter(function (c) {
    if (!q) return true;
    return (c.name + ' ' + (c.org || '') + ' ' + (c.email || '') + ' ' + (c.phone || ''))
      .toLowerCase().indexOf(q) >= 0;
  });
  var cols = canEditContacts() ? 7 : 6;
  if (!rows.length) {
    return '<tr><td colspan="' + cols + '"><div class="empty">' +
      (q ? 'No contact matches “' + esc(q) + '” in what’s loaded.'
         : (CONTACTS_UI.mode === 'archived'
            ? 'Nothing archived — nobody has been retired from the rolodex yet.'
            : 'The rolodex is empty. Add the first contact — a venue ops manager, a client producer, a vendor rep.')) +
      '</div></td></tr>';
  }
  return rows.map(contactRow).join('');
}

function viewContacts(rows) {
  CONTACTS_LAST = rows || [];
  var canEdit = canEditContacts();
  var kindSeg = '<div class="seg">' +
    [['', 'All']].concat(CONTACT_KINDS.map(function (k) { return [k, k.charAt(0).toUpperCase() + k.slice(1)]; }))
      .map(function (m) {
        return '<button class="' + (CONTACTS_UI.kind === m[0] ? 'on' : '') + '" ' +
          act('ctKind', null, m[0] || 'all') + '>' + esc(m[1]) + '</button>';
      }).join('') + '</div>';
  var modeSeg = '<div class="seg">' +
    [['active', 'Active'], ['archived', 'Archived']].map(function (m) {
      return '<button class="' + (CONTACTS_UI.mode === m[0] ? 'on' : '') + '" ' +
        act('ctMode', null, m[0]) + '>' + esc(m[1]) + '</button>';
    }).join('') + '</div>';

  var head = '<tr><th>Name</th><th>Org</th><th>Kind</th><th>Email</th><th>Phone</th>' +
    '<th title="Shows this contact is linked to">Shows</th>' + (canEdit ? '<th>Manage</th>' : '') + '</tr>';

  return '<div class="page-h"><div><h1>Contacts</h1><div class="sub">The rolodex — clients, venues, vendors ' +
    'and local crew, one card each. The call sheet’s POC fields fill from here; “People on this show” links back.</div></div>' +
    (canEdit ? '<button class="btn primary" ' + act('ctAdd') + '>' + icon('plus') + 'Add contact</button>' : '') +
    '</div>' +
    '<div class="sched-bar" style="margin-bottom:12px;flex-wrap:wrap;gap:9px">' +
    '<input id="ctSearch" class="cell-in" style="max-width:260px" placeholder="Filter by name, org, email, phone…" value="' +
      esc(CONTACTS_UI.q) + '">' +
    kindSeg + '<span style="flex:1"></span>' + modeSeg + '</div>' +
    '<div class="card" style="margin-bottom:16px"><div class="card-h"><h3>' +
    (CONTACTS_UI.mode === 'archived' ? 'Archived' : 'Rolodex') + '</h3>' +
    '<span class="pill idle">' + CONTACTS_LAST.length +
    (CONTACTS_UI.kind ? ' ' + esc(CONTACTS_UI.kind) : '') +
    (CONTACTS_UI.mode === 'archived' ? ' archived' : '') + '</span></div>' +
    '<div class="tbl-wrap"><table class="tbl"><thead>' + head + '</thead>' +
    '<tbody id="ctRows">' + contactRowsHTML() + '</tbody></table></div></div>' +
    '<div class="perm-note">' + inlineIcon('box') + ' Archive is the retirement path — the card leaves the ' +
    'working set but every show it was ever on keeps its record, and search still finds it. Hard delete is ' +
    'admin-only and refuses while the contact is linked to any show.</div>';
}

/* ── "People on this show" — the schedule tab's rolodex panel ───────────────
   Renders beside the free-text POC cards. The two answer different questions:
   the POC card is "who do I call at 6am" (free text, prints on the sheet);
   this panel is the STRUCTURED link, so the contact's own card can answer
   "where is this person used". */
function showContactsPanel(show, editable) {
  var links = contactsForShow(show.id);
  var rows = links.map(function (x) {
    var c = x.contact;
    return '<div class="poc-card"><div class="poc-t"><span>' + esc(x.link.role || c.kind) + '</span>' +
      '<button style="padding:0;background:none;border:0;cursor:pointer;text-align:left;color:var(--text);font-family:inherit" ' +
        act('openContact', c.id) + '><b>' + esc(c.name) + '</b></button>' +
      (c.org || c.title ? '<i>' + esc([c.org, c.title].filter(Boolean).join(' · ')) + '</i>' : '') + '</div>' +
      '<span style="display:flex;gap:6px;align-items:center">' +
      (c.phone ? '<a class="btn sm poc-tel" href="' + esc(telHref(c.phone)) + '">' + icon('phone') + esc(c.phone) + '</a>' : '') +
      (editable ? '<button class="iconbtn" title="Take off this show (the contact keeps its card)" ' +
        act('scUnlink', c.id, String(show.id)) + '>' + icon('x') + '</button>' : '') +
      '</span></div>';
  }).join('');
  return '<div class="panel"><h3>People on this show' +
    '<span style="flex:1"></span>' +
    (editable ? '<button class="btn sm ghost" ' + act('scAdd', show.id) + '>' + icon('plus') + 'Link contact</button>' : '') +
    '</h3><div class="poc-list">' +
    (rows || '<div class="empty" style="padding:16px;font-size:12.5px">Nobody linked from the rolodex yet. ' +
      'Linking is what lets a contact’s card answer “which shows was I on”.</div>') +
    '</div></div>';
}
