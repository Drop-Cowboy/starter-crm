# Build your CRM with an AI assistant

This page is for people building with an AI coding assistant, such as Cursor,
Claude Code, Windsurf or GitHub Copilot, whether or not you write code
yourself. When you're done you'll have the starter running, an assistant that
knows how it works, and prompts to make it yours.

You'll need a Drop Cowboy account on a paid plan, because free trials can't
create the API key the starter uses. Calling and texting 555 test numbers is
free and needs no balance, no carrier and no business number, so you can build
everything here before you reach a real phone.

- [How it goes](#how-it-goes)
- [Step 1: get your own copy](#step-1-get-your-own-copy)
- [Step 2: connect your assistant to Drop Cowboy](#step-2-connect-your-assistant-to-drop-cowboy)
- [Step 3: get it running](#step-3-get-it-running)
- [Prompts to make it yours](#prompts-to-make-it-yours)
- [Check what it did](#check-what-it-did)
- [Never accept these](#never-accept-these)
- [Lovable, Bolt and ChatGPT](#lovable-bolt-and-chatgpt)

## How it goes

1. You get your own copy of the starter.
2. You connect your assistant to Drop Cowboy, so it can look things up
   instead of guessing.
3. The assistant helps you get it running.
4. You ask for changes in plain words, one at a time, and check each one.

The starter comes with [`AGENTS.md`](../AGENTS.md), a page of rules written for
AI assistants: which file to change for what, and what must never change.
Most assistants read it by themselves. If yours doesn't, start each chat with
"Read AGENTS.md first."

## Step 1: get your own copy

First, make the copy: on [GitHub](https://github.com/Drop-Cowboy/starter-crm),
click **Use this template > Create a new repository**. This copy is yours, so
you can save your changes and deploy them. Then pick where to work on it:

- **In the browser, nothing to install:** in *your* new repository, click
  **Code > Codespaces > Create codespace on main**. That opens VS Code in your
  browser, already set up. Use GitHub Copilot there, if your GitHub plan
  includes it.
- **On your computer:** open your repository in your assistant. Cursor and
  VS Code can download it from the welcome screen (**Clone Git Repository**,
  then paste your repository's address), or ask your assistant to "clone my
  repository".

## Step 2: connect your assistant to Drop Cowboy

Drop Cowboy has an **MCP server**. MCP is a standard way for an AI tool to use
another service. Connected, your assistant can check what your account still
needs, look up how each part of Drop Cowboy works, and read your API logs when
something fails.

The server's address is `https://mcp.dropcowboy.com/mcp`. In the dashboard,
open [**Connect AI**](https://www.dropcowboy.com/app/#/connect-ai-tools) and
pick your tool. It shows exactly what to do:

| Tool | How it connects |
|---|---|
| Cursor | Connect AI makes an API key for you and shows a block to add to `~/.cursor/mcp.json`. |
| Windsurf | The same, added to `~/.codeium/windsurf/mcp_config.json`. |
| VS Code and GitHub Copilot | Add an HTTP MCP server with the address above. VS Code asks you to sign in. |
| Claude Code | Run `claude mcp add --transport http dropcowboy https://mcp.dropcowboy.com/mcp`, then `/mcp`, and sign in. |
| Claude (web and desktop) | **Customize > Connectors > Add custom connector**. Paste the address and sign in. |

**The MCP server acts on your real account.** If you ask it to send something
to a real phone number, it sends it. While you build, ask it to use 555
numbers only.

The [Drop Cowboy hub](https://github.com/Drop-Cowboy/dropcowboy/blob/main/docs/vibe-coding.md)
has more on connecting each tool.

## Step 3: get it running

Paste this into your assistant:

```text
Read AGENTS.md and README.md. Help me run this Starter CRM on my computer.

1. Check that Node.js 24 or later is installed, and tell me how to install it if not.
2. Use the Drop Cowboy MCP server to check what my account needs, following
   get_builder_setup_guide with goal "crm". Skip anything about voice agents.
   Tell me about any step only I can do, such as billing; don't do those.
3. Tell me how to create an API key in the dashboard under Developers > API
   Keys. Don't create it yourself, and never ask me to paste the secret into
   this chat: I'll run npm run setup in the terminal and paste it there.
4. Run npm start and tell me what to open.
5. Add a contact named Test Person with the number +1 555 555 0002, and
   tell me how to call and text it from the app.
```

`npm run setup` asks four questions; press Enter for the first and last, and
paste your key and secret for the middle two. In a Codespace, or any time you
run it again, it first asks `.env already exists. Replace it with new
settings?`: type `y` and press Enter, or it keeps the old settings and asks
nothing more. If anything goes wrong, ask the assistant to run
`npm run doctor`, which checks the settings and says what to fix.

## Prompts to make it yours

Paste one at a time, check the result, then go on. Change the parts in
capitals.

### Rebrand it

```text
Rename this CRM to ACME CRM. Make the brand colour #0F766E, in the light and
dark themes, and change the logo letter to A. Follow "Common changes" in
CUSTOMIZE.md, change both front-ends, and update any test that checks the old
name. Then run npm test.
```

### Add a field to deals

```text
Add a "close date" to deals in the Deals module. Change the schema in
server/schemas, both servers, the client in shared/deals-api.js, and the Deals
page in both front-ends. Add tests for it, then run npm test.
```

### Build a screen of your own

```text
Build a Tickets module, following "Add a module" in CUSTOMIZE.md. Start with
npm run new:module -- tickets. A ticket has a title, a status (open, waiting,
closed), notes and an optional contact. Replace the Tickets placeholder with a
page in both front-ends, copying how the Deals page works, and wire it into
vanilla/pages/module.js and react/src/pages/ModulePage.jsx the way Deals is.
Show the contact card beside a ticket that has a contact. Add tests, then run
npm test.
```

### React to something that happens

```text
When a contact enters the pipeline stage named CLOSED WON, create a deal for
them in the Deals module, at the Won stage, unless they already have one.
Do it in the Deals module's onEvent handler (and on_event in Python), for the
contact.pipeline.stage.entered event. It can run twice for the same event, so
make running twice harmless. Add tests, then run npm test.
```

This needs webhooks set up, so Drop Cowboy can tell your server when a stage
changes. See [Webhooks](webhooks.md).

### Let your team sign in

```text
Set up sign-in with a shared passcode, following "Choose who signs in" in
CUSTOMIZE.md. Generate a strong passcode and tell me how to set it in .env
myself; don't print it in this chat again.
```

### Put it on the internet

```text
Help me deploy this to Netlify, following the Netlify section of HOSTING.md.
Don't put my API key, secret or passcode in any file that git commits; tell
me where in Netlify to enter them. When it's up, run npm run test:deployed
against the address.
```

Then follow [Webhooks](webhooks.md) to point Drop Cowboy at the new address,
and go through the [production checklist](../PRODUCTION.md) before real users
sign in.

## Check what it did

After each change:

1. **Run the tests:** ask the assistant to run `npm test`, or run it yourself.
   The summary at the end lists each stage; none should say `FAIL`. None of
   the tests use your account or cost anything.
2. **Try it:** open the app, and call and text a 555 contact.
3. **Read the summary:** a good assistant says which files it changed and
   why. Ask it to if it doesn't.

If something breaks, tell the assistant exactly what you see, such as the
words on the screen, and ask it to check [Troubleshooting](../TROUBLESHOOTING.md).

## Never accept these

Some changes look like they work but make your CRM unsafe. If your assistant
suggests any of these, say no and point it at the rule in `AGENTS.md`:

- **Your API key or secret in browser code**, meaning anything in `vanilla/`,
  `react/` or `shared/`, or in a file git commits. Only the server reads them.
- **A token in an address, in browser storage or in a log.** Tokens are
  passed in code only.
- **Letting the browser choose what a token can do.** The server decides,
  from the page's purpose.
- **Loading Drop Cowboy's scripts from `latest`, or removing their
  `integrity` check.** Or installing a Drop Cowboy package: there isn't one,
  and the scripts load from Drop Cowboy.
- **Working around `consent_required`.** It means the contact hasn't agreed to
  be called or texted. Record their consent instead.
- **Deleting or weakening a test to make it pass**, or deleting the comments
  that explain the code.
- **Editing the server's core, sign-in or webhook code to add a feature.** Use
  a module or a setting, so upgrading the starter stays easy.
- **Code that starts work and doesn't wait for it** in the server. Everything
  must finish before the server answers.

## Lovable, Bolt and ChatGPT

These tools work differently from a coding assistant in your own copy:

- **Bolt and similar tools that can open a GitHub repository and deploy to
  Netlify.** Open your copy, then follow the Netlify section of
  [Hosting](../HOSTING.md). The Netlify version of the server is built for
  this.
- **Lovable** builds its own apps on its own backend, so it can't run this
  server. Use the starter as a guide instead: ask Lovable to keep your API key
  as a secret, call Drop Cowboy only from a backend function, and give the page
  a short-lived token, the way [How it works](how-it-works.md) describes.
- **ChatGPT** can't connect to the MCP server yet. Paste `AGENTS.md` and the
  file you want changed into the chat, and copy the answer back yourself.
