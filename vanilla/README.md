# vanilla/

This is one of two front-ends for the Starter CRM. Start at the folder above
this one.

The Starter CRM with no framework and no build step. The starter server serves
this folder, so start a server (see `../server/node` or `../server/python`) and
open <http://127.0.0.1:8080>. Add `?layout=embedded` to see it without its top
bar and navigation, as it would sit inside a page of your existing app.

The layout and styles live in `../shared/crm.css`, and the layout, theme and
command-palette logic in `../shared/ui.js`; the React front-end uses the same
two files, so both draw the same markup.

| File | What it is |
|---|---|
| `index.html` | The app frame: top bar, navigation, the contacts list, main and context regions, a live region for toasts. |
| `app.js` | Boot: `startCrm()`, mounts the Dock once, starts the activity feed, the contacts list, the palette and the router. |
| `router.js` | A small History API router. Each page is `render(main, ctx)` and may return a cleanup function. Links keep `?layout=embedded`. |
| `shell.js` | The frame's state: which regions show, the collapsible navigation, the context rail and the Activity drawer. |
| `contact-list.js` | The contacts list beside the contact pages. It stays put while you open contacts. |
| `palette.js` | Cmd+K / Ctrl+K: find a contact, call or text one, or go to a page. |
| `activity.js` | The live activity feed and toasts. |
| `tabs.js` | Accessible tabs, used by the contact page. |
| `consent-sheet.js`, `consent-form.js` | The Record consent side sheet and its form. |
| `contact-form.js` | The add and edit contact form. |
| `page.js` | A page's title row, and the frame that labels each Drop Cowboy widget. |
| `notice.js` | Error and info notices, and the banner. |
| `dom.js` | `h(tag, attrs, ...children)` and `icon(name)`, the only DOM helpers. |
| `pages/` | One file per page. |

## Pages and the Building Blocks they use

| Page | Uses |
|---|---|
| Contacts (`/contacts`) | Contacts REST API only: search, page through. |
| Add a contact (`/contacts/new`) | Contacts REST API. An existing match opens instead of a duplicate. |
| Contact (`/contacts/:id`) | REST API for editing and deleting, `<dc-contact-card>` (with its timeline), consent records, and the Dock for Call and Text. |
| Pipeline (`/pipeline`) | `<dc-pipeline-board>`. Opening a card opens the contact. |
| Inbox (`/inbox`) | `<dc-shared-inbox>`, sending from your business number. |
| Campaigns (`/campaigns`) | The campaign hub with a read-only campaigns token. |
| Phone (`/phone`) | `<dc-phone-hub>` and `<dc-number-picker>` with the phone token. Renting a number asks first. |
| Setup (`/setup`) | How this app signs in, the account checklist, the business number. |
| Your modules (`/modules/:id`) | Placeholders for your own screens. Add an entry to `MODULES` in `../shared/ui.js` and a page in `pages/`. |

The Dock is on every page. Its error events, and webhooks arriving on
`/api/events`, show up in the Activity list (the context rail on a wide
contact page, or the drawer the top bar's Activity button opens) and as toasts.

Each page holds one token per purpose, however many widgets it shows, and
only the purposes it needs:

| Token | Who uses it |
|---|---|
| `contacts` | The contacts list, the Contact and Pipeline pages, and the palette's contact search: the REST calls, and `<dc-contact-card>` and `<dc-pipeline-board>` through the contacts bundle's token manager (`DropCowboy.contacts.getTokenManager()`). |
| `session` | The Dock, and `<dc-shared-inbox>`, which borrows the Dock's token manager (`DropCowboy.dock.getTokenManager()`). |

Drop Cowboy refuses to mint a calling token until the team has a connected
carrier and a balance. Because the contacts pages never need the session
token, they keep working then, and the banner says why the Dock is not
available (`byoc_required`, `insufficient_balance`).
