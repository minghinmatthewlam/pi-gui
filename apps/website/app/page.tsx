import { CopyCommand } from "./components/copy-command";
import { DownloadButton } from "./components/download-button";
import { ThemedShot } from "./components/themed-shot";
import {
  BREW_INSTALL,
  GITHUB_URL,
  OG_IMAGE_PATH,
  PI_URL,
  RELEASES_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
} from "./site";

const softwareApplicationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Linux, Windows",
  description: SITE_DESCRIPTION,
  url: SITE_URL,
  sameAs: [GITHUB_URL],
  image: `${SITE_URL}${OG_IMAGE_PATH}`,
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

const showcase = [
  {
    eyebrow: "Threads",
    title: "Run agents side by side",
    body: "Every task gets its own thread. Start it in your checkout or in a fresh git worktree, then start the next one while it works. The sidebar shows what is running, what finished and what needs you.",
    shot: "threads",
    width: 1640,
    height: 1026,
    dark: false,
    alt: "pi-gui running an agent thread while two other threads sit in the sidebar",
  },
  {
    eyebrow: "Review",
    title: "Review every change before it lands",
    body: "The Changes tab shows exactly what the agent touched. Compare uncommitted work, a branch against its base, or a single turn, and stage it file by file.",
    shot: "review",
    width: 1240,
    height: 758,
    dark: true,
    alt: "The Changes tab showing the diff an agent made to src/price.js",
  },
  {
    eyebrow: "Workbench",
    title: "Terminal and files in the same window",
    body: "Open a real terminal, browse and edit files, or manage worktrees in tabs beside the conversation. Each task keeps its own layout.",
    shot: "terminal",
    width: 1240,
    height: 992,
    dark: true,
    alt: "The integrated terminal running the test suite next to the thread",
  },
  {
    eyebrow: "Keyboard",
    title: "Everything is a keystroke away",
    body: "⌘K searches chats, workspaces and actions. ⌘P jumps to any file. Ctrl-Tab flips between recent threads, and ⌘1 to ⌘9 jump to threads in the sidebar. On Linux and Windows, use Ctrl.",
    shot: "palette",
    width: 1440,
    height: 1280,
    dark: true,
    alt: "The command palette listing recent chats and actions",
  },
] as const;

const features = [
  {
    title: "Queue and steer",
    body: "Line up follow-ups while a run is going, or steer the current run without stopping it.",
  },
  {
    title: "Scheduled tasks",
    body: "Have pi rerun a prompt on a schedule, such as a weekly dependency check, while the app is open.",
  },
  {
    title: "Skills and extensions",
    body: "Turn pi skills and extensions on and off, try them from the composer, and give extensions their own tabs.",
  },
  {
    title: "Any provider",
    body: "Sign in with OAuth, paste an API key, or point at a custom endpoint. Pick the model and thinking level per thread.",
  },
  {
    title: "Your sessions, on disk",
    body: "pi-gui reads and writes pi's own session files. Anything you set up with the pi CLI carries over.",
  },
  {
    title: "Fork and rewind",
    body: "Fork a thread from any message into the same checkout or a new worktree, and move around the session tree.",
  },
  {
    title: "Notifications",
    body: "Get told when a background thread finishes, fails or needs your attention.",
  },
  {
    title: "Themes",
    body: "Light and dark, plus presets like Catppuccin, Tokyo Night, Nord, Dracula and GitHub.",
  },
] as const;

const installs = [
  {
    platform: "macOS",
    detail: "Apple Silicon. Signed and notarized.",
    steps:
      "Download the .dmg from GitHub Releases and drag pi-gui into Applications, or install with Homebrew:",
    command: BREW_INSTALL,
  },
  {
    platform: "Linux",
    detail: "x64 AppImage or .deb.",
    steps: "Download the AppImage or the .deb package from GitHub Releases.",
  },
  {
    platform: "Windows",
    detail: "x64 installer or portable build.",
    steps:
      "Download the setup .exe or the portable .exe from GitHub Releases. Builds are not code-signed yet, so SmartScreen may ask you to confirm.",
  },
] as const;

const faqs = [
  {
    q: "What is pi?",
    a: (
      <>
        <a href={PI_URL}>pi</a> is an open source coding agent that runs in your terminal. pi-gui is
        a desktop app on top of it: sessions, models, tools and auth all run through pi itself.
      </>
    ),
  },
  {
    q: "Does it cost anything?",
    a: "pi-gui is free and MIT licensed. You bring your own model provider, through a subscription sign-in or an API key.",
  },
  {
    q: "Can I keep using the pi CLI?",
    a: "Yes. pi-gui uses pi's own session files and settings, so threads, credentials and skills are shared between the two.",
  },
  {
    q: "Where does my code go?",
    a: "pi-gui runs on your machine. Your code goes only to the model provider you configure, the same way it does with the pi CLI. The app also checks GitHub for new releases.",
  },
  {
    q: "How do updates work?",
    a: "pi-gui tells you when a new release is out. Homebrew installs update with brew upgrade --cask pi-gui; other installs update from GitHub Releases.",
  },
] as const;

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function Logo() {
  return (
    <a className="logo" href="#top" aria-label="pi-gui home">
      <img src="/icon.svg" alt="" width={24} height={24} />
      <span>pi-gui</span>
    </a>
  );
}

export default function Page() {
  return (
    <>
      <header className="nav">
        <div className="nav__inner">
          <Logo />
          <nav className="nav__links" aria-label="Main">
            <a href="#features">Features</a>
            <a href="#install">Install</a>
            <a href="#faq">FAQ</a>
            <a href={GITHUB_URL} className="nav__github">
              <GitHubIcon />
              GitHub
            </a>
          </nav>
          <DownloadButton className="button button--primary button--small" />
        </div>
      </header>

      <main id="top">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationJsonLd) }}
        />

        <section className="hero">
          <div className="container">
            <a className="hero__badge" href={RELEASES_URL}>
              Public beta for macOS, Linux and Windows
              <span aria-hidden="true">→</span>
            </a>
            <h1>The desktop app for the pi coding agent</h1>
            <p className="hero__lede">
              Run agents in parallel threads, in your checkout or their own worktrees. Review every
              change, then ship it without leaving the window.
            </p>
            <div className="hero__actions">
              <DownloadButton className="button button--primary" />
              <a className="button button--secondary" href={GITHUB_URL}>
                View on GitHub
              </a>
            </div>
            <p className="hero__note">Free and open source. Built on pi.</p>
          </div>
          <div className="container container--wide">
            <div className="frame frame--hero">
              <video
                autoPlay
                loop
                muted
                playsInline
                preload="auto"
                poster="/media/hero-poster.webp"
                width={1920}
                height={1200}
                aria-label="An agent in pi-gui fixing a bug, running the tests, then the change open in the review tab"
              >
                <source src="/media/hero.webm" type="video/webm" />
                <source src="/media/hero.mp4" type="video/mp4" />
              </video>
            </div>
          </div>
        </section>

        <section id="features" className="showcase">
          <div className="container">
            {showcase.map((item, index) => (
              <article
                key={item.title}
                className={`showcase__row${index % 2 === 1 ? " showcase__row--flip" : ""}`}
              >
                <div className="showcase__copy">
                  <p className="eyebrow">{item.eyebrow}</p>
                  <h2>{item.title}</h2>
                  <p>{item.body}</p>
                </div>
                <div className="frame">
                  <ThemedShot
                    name={item.shot}
                    alt={item.alt}
                    width={item.width}
                    height={item.height}
                    dark={item.dark}
                  />
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="grid-section">
          <div className="container">
            <h2 className="section-title">And the rest of the workflow</h2>
            <div className="feature-grid">
              {features.map((feature) => (
                <div key={feature.title} className="feature-grid__item">
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="install" className="install">
          <div className="container">
            <h2 className="section-title">Install the beta</h2>
            <p className="section-lede">
              Download the latest build from <a href={RELEASES_URL}>GitHub Releases</a>, or install
              with Homebrew on macOS. Then connect a provider under Settings, add a project folder
              and start a thread.
            </p>
            <div className="install__grid">
              {installs.map((item) => (
                <div key={item.platform} className="install__card">
                  <h3>{item.platform}</h3>
                  <p className="install__detail">{item.detail}</p>
                  <p>{item.steps}</p>
                  {"command" in item ? <CopyCommand command={item.command} /> : null}
                </div>
              ))}
            </div>
            <p className="install__source">
              Building from source is for contributors: see the{" "}
              <a href={`${GITHUB_URL}#development`}>development guide</a>.
            </p>
          </div>
        </section>

        <section id="faq" className="faq">
          <div className="container container--narrow">
            <h2 className="section-title">Questions</h2>
            {faqs.map((item) => (
              <details key={item.q} className="faq__item">
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="closing">
          <div className="container">
            <h2>Give pi a desktop</h2>
            <div className="hero__actions">
              <DownloadButton className="button button--primary" />
              <a className="button button--secondary" href={GITHUB_URL}>
                View on GitHub
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="footer__inner">
          <Logo />
          <nav className="footer__links" aria-label="Footer">
            <a href={GITHUB_URL}>GitHub</a>
            <a href={RELEASES_URL}>Releases</a>
            <a href={PI_URL}>pi</a>
            <a href={`${GITHUB_URL}/blob/main/LICENSE`}>MIT License</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
