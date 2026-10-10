# react/

This is one of two front-ends for the Starter CRM. Start at the folder above
this one.

The same CRM as `../vanilla`, in React 19 with React Router. It uses the same
`../shared` modules, so only the rendering differs.

```bash
npm install
npm run dev      # http://localhost:5173/react/ , needs a starter server on 127.0.0.1:8080
npm run build    # writes dist/, which the starter server serves at /react/
npm test         # vitest + Testing Library
npm run lint
```

In development Vite forwards `/api`, `/__dev`, `/shared` and `/webhooks` to
the starter server, so the browser sees one origin, as it does in production.
In `login` mode, add `http://localhost:5173/react/` as an allowed callback URL
next to `http://127.0.0.1:8080/react/`.

## How it is laid out

Both front-ends render the same DOM (roles, names, classes), styled by
`../shared/crm.css`, and one Playwright suite in `../tests/e2e` runs against
both. When you change markup here, change `../vanilla` to match.

- `components/Layout.jsx` is the shell: top bar, navigation, the contacts
  list beside contact pages, the page, and the context panel (contact details
  and live activity). The panel is a rail on wide screens and a drawer
  elsewhere. Layout state lives in data attributes on `.app` (`data-layout`,
  `data-nav`, `data-list`, `data-selection`, `data-context`), which the CSS
  reads. `?layout=embedded` drops the top bar and navigation and stays on as
  you move between pages.
- `components/CommandPalette.jsx` is Cmd+K / Ctrl+K: find a contact, call or
  text one, or go to a page.
- `pages/` holds one component per route. The contact page has
  Overview / Activity / Consent / Edit tabs, a consent sheet and a delete
  dialog. The contact card stays mounted while another tab is open.
- `hooks.js` holds `useMediaQuery`, `useModalDialog` (native `<dialog>`,
  focus goes back to the opener on close) and `useActivityItems`.

## How the Building Blocks are wrapped

React 19 passes props to a custom element as JavaScript properties when the
element defines them. So each Building Block gets a tiny wrapper in
`src/blocks/` that renders the element with its properties as props and
listens for its events through a ref:

```jsx
<dc-contact-card ref={ref} apiBase={crm.widgetApiBase} tokenManager={tokenManager} contactId={id} />
```

- The element must be defined before it renders with those props, or React
  would fall back to attributes. `useContactWidgets()` (contact card,
  pipeline: the `contacts` token) and `useSessionWidgets()` (inbox: the Dock's
  `session` token) load the bundle first. This is also what keeps the token
  manager out of the DOM. The contacts pages never wait for the Dock, so they
  work for a team that has not connected a carrier yet.
- Events (`dc-call`, `dc-open-contact`, `dc-error`, ...) are received with
  `useElementEvent(ref, type, handler)`.
- The campaign hub and phone hub are opened by their bundles (`useOpenWidget`).
  Their bundles keep one hub per page, so opens and closes are queued. React
  runs effects twice in development, and an overlapping close would shut the
  newly opened hub.

| Wrapper | Element |
|---|---|
| `DcContactCard` | `<dc-contact-card>` |
| `DcPipelineBoard` | `<dc-pipeline-board>` |
| `DcSharedInbox` | `<dc-shared-inbox>` |
| `CampaignHub` | the campaigns bundle's hub, in a container div |
| `DcPhoneHub`, `DcNumberPicker` | `<dc-phone-hub>`, `<dc-number-picker>` |
