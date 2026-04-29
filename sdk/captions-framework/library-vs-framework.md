# Proposal: Library or Framework? Pick before we write the API spec

**Status:** Proposal, needs decision today
**Audience:** Cloud and miniapp engineering, leadership

## TL;DR

I was asked to write the API shape for the MentraOS developer surface. Before I do, I want to surface a choice we haven't explicitly made: **are we building a library or a framework?** The doc I write will be very different depending on the answer, and the difference matters for OEMs, AI-written apps, and indie devs.

I think we should pick today.

## The question

Two valid shapes for the dev surface. Both are partially built somewhere in the repo right now. They are not compatible. They imply different mental models, different project structures, different docs, different examples.

### Option A: Library

> "Here are some packages. `import { MiniappSession } from '@mentra/...'`. Sprinkle into your React app however you like."

- Developer owns the project structure.
- One package, with a React subpath import for convenience.
- Docs are an API reference: "here are the modules and methods."
- Closest analog: `react-router`, `@tanstack/query`, plain SDKs.

### Option B: Framework

> "Here is the project shape. `client/` runs on the phone. `webview/` is React UI. `server/` is your optional cloud backend. We police the boundary."

- Framework owns the project structure.
- Folders have meaning. The build system rejects code that imports the wrong primitive in the wrong folder.
- Docs are a project-model spec: "here's what each folder is for, here's the lifecycle, here's what's forbidden."
- Closest analog: Next.js, Expo, SvelteKit.

## Why this matters for the things we already care about

| Concern                                        | Library shape                                                                                                                                                                         | Framework shape                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OEMs** can ship without our cloud            | Yes (independent of shape)                                                                                                                                                            | Yes (independent of shape)                                                                                                                                                          |
| **AI-written miniapps** are correct by default | Risky. Nothing stops the AI from putting hardware-side effects inside React render functions, or putting cloud-only code in the WebView                                               | Strong. The project shape physically separates concerns; AI cannot put `session.layouts.showTextWall(...)` in a React component because it doesn't have access to the runtime there |
| **Indie devs** can iterate fast                | Good after they understand the patterns                                                                                                                                               | Good immediately. The structure is the documentation                                                                                                                                |
| **Mistakes a junior dev would make**           | "Subscribed to transcription inside `useEffect` and it leaks", "called `session.takePhoto()` on every render", "wrote backend logic inside the WebView". All silent and hard to debug | Caught at build time or impossible to express                                                                                                                                       |
| **OEM partner integration**                    | They write a React app and add our package                                                                                                                                            | They scaffold a project with the right shape; their team understands the boundaries on day one                                                                                      |

The framework shape doesn't add capabilities. It removes the ability to make mistakes. That's the value.

## Why I'm raising this now

I've talked with the miniapp lead. He's already started writing his own folder convention with managers, informally, because the SDK as currently shaped doesn't tell him where things go. He's reinventing what a framework would have given him.

If we don't decide framework vs library, every miniapp will pick its own conventions, every developer will pick a different style, and the AI agents writing apps for partners will pick whatever the most recent example looks like. We end up with a "library that feels like it wishes it were a framework", the worst of both worlds.

## What I'm proposing

**Pick framework.**

Reasoning, briefly:

1. **The "AI-coded miniapps" thesis only holds with a framework.** If the model is "AI writes a Mentra app", we want the project shape to be so opinionated that AI literally cannot generate broken code in the wrong place. That's the entire point of `pages/` in Next.js or `app/` in Expo Router. Not convenience, but constraint.

2. **OEMs love opinion.** A partner engineering team forking a fully-shaped project (`client/`, `webview/`, `server/`, `mentra.config.ts`) and replacing the contents is a weekend job. Forking a library and figuring out the right structure is a multi-week negotiation about coding style.

3. **Our internal first-party apps will benefit too.** Captions, translation, notes, merge: all need the same client/webview/server split. A framework lets us delete custom per-app boilerplate.

4. **A library can come out of a framework.** If we ship the framework and someone really wants to use the primitives à la carte, we can publish them separately later. The reverse, going from library to framework, is a breaking-change migration.

## What I want decided today

1. **Library or framework?** (Yes/no on each.)
2. If framework: **what are the folders?** My strawman is `client/` (phone) + `webview/` (React UI) + `server/` (optional cloud) + `shared/` (types). Open to discussion.
3. If framework: **who owns the dev tooling?** (`mentra dev`, `mentra build`, project scaffolder.) One person, one repo, one canonical implementation. Right now there are two partial efforts.
4. **Where does the framework live in the monorepo?** Probably not under `cloud/`. A peer of `cloud/`, `mobile/`, `asg_client/`. It's a developer-facing artifact, not a cloud component.

Once these four are answered, the API-shape doc I was asked to write becomes straightforward to draft. Without these answered, the doc will be wrong by next week regardless of which version I write.

## What's not on the table in this proposal

- Not asking to rip out anyone's code. Both current efforts are experimental and have useful pieces.
- Not asking to delay shipping. A framework can land iteratively. Start with the folder convention and one example app, expand from there.
- Not arguing about React vs vanilla. React stays as the recommended way to write `webview/` in either model. Framework just means React is _one layer_, not the whole product.

---

**One sentence to remember if we run out of time:** the difference between library and framework is whether the developer or the platform owns the project shape, and right now we're shipping ambiguity.
