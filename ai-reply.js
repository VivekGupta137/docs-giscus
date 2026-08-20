/**
 * Giscus / GitHub Discussions AI reply (lives in the Giscus repo).
 * Maps discussion pathname → markdown in the checked-out docs repo.
 */
const fs = require("node:fs");
const path = require("node:path");
const { GoogleGenAI } = require("@google/genai");

const ALLOWED_USER = "VivekGupta137";
const MAX_DOC_CHARS = 12_000;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.7-flash";
const DOCS_ROOT = process.env.DOCS_ROOT || path.join("private-site-code", "src", "content", "docs");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function normalizePathname(raw) {
  let value = (raw || "").trim();
  if (!value) return "";

  try {
    if (/^https?:\/\//i.test(value)) {
      value = new URL(value).pathname;
    }
  } catch {
    // keep original
  }

  return value.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

function pathnameFromDiscussion(title, body) {
  const fromTitle = normalizePathname(title);
  if (fromTitle && !/\s/.test(fromTitle)) return fromTitle;

  const urlMatch = String(body || "").match(/https?:\/\/[^\s)]+/i);
  if (urlMatch) return normalizePathname(urlMatch[0]);

  return fromTitle;
}

function candidateFiles(pathname) {
  if (!pathname) return ["index.mdx", "index.md"];
  return [
    `${pathname}.md`,
    `${pathname}.mdx`,
    path.join(pathname, "index.md"),
    path.join(pathname, "index.mdx"),
  ];
}

function readDoc(pathname) {
  const root = path.resolve(DOCS_ROOT);
  for (const rel of candidateFiles(pathname)) {
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep) && full !== root) continue;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return { file: rel.replace(/\\/g, "/"), markdown: fs.readFileSync(full, "utf8") };
    }
  }
  return null;
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function selectRelevantMarkdown(markdown, question) {
  const body = stripFrontmatter(markdown).trim();
  if (body.length <= MAX_DOC_CHARS) return body;

  const terms = new Set(
    question
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((w) => w.length > 2),
  );

  const sections = body.split(/(?=^#{1,3} )/m);
  const scored = sections.map((section, i) => {
    const text = section.toLowerCase();
    let score = i === 0 ? 2 : 0;
    for (const term of terms) {
      if (text.includes(term)) score += 1;
    }
    return { section, score, i };
  });

  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  let out = "";
  for (const { section } of scored) {
    if (!section.trim()) continue;
    if (out.length + section.length > MAX_DOC_CHARS) continue;
    out += (out ? "\n\n" : "") + section.trim();
  }

  return (out || body.slice(0, MAX_DOC_CHARS)).trim();
}

async function postReply(token, { discussionId, replyToId, body }) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "ai-giscus-reply",
    },
    body: JSON.stringify({
      query: `mutation ($discussionId: ID!, $body: String!, $replyToId: ID) {
        addDiscussionComment(input: {
          discussionId: $discussionId
          body: $body
          replyToId: $replyToId
        }) {
          comment { id }
        }
      }`,
      variables: { discussionId, body, replyToId },
    }),
  });

  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`GitHub GraphQL failed: ${JSON.stringify(json.errors || json)}`);
  }
}

async function main() {
  const commentUser = process.env.COMMENT_USER || "";
  if (commentUser !== ALLOWED_USER) {
    console.log(`Skip: user "${commentUser}" is not ${ALLOWED_USER}`);
    return;
  }

  const token = requiredEnv("GITHUB_TOKEN");
  const geminiKey = requiredEnv("GEMINI_API_KEY");
  console.log(`Using Gemini model ${MODEL}`);
  const discussionTitle = process.env.DISCUSSION_TITLE || "";
  const discussionBody = process.env.DISCUSSION_BODY || "";
  const commentBody = (process.env.COMMENT_BODY || "").trim();
  const discussionId = process.env.DISCUSSION_ID;
  const replyToId = process.env.REPLY_TO_ID;

  if (!commentBody) {
    console.log("Skip: empty comment");
    return;
  }
  if (!discussionId || !replyToId) {
    throw new Error("Missing discussion or comment node id");
  }

  const pathname = pathnameFromDiscussion(discussionTitle, discussionBody);
  const doc = readDoc(pathname);

  if (!doc) {
    console.log(`No markdown for pathname "${pathname}"`);
    await postReply(token, {
      discussionId,
      replyToId,
      body: `_AI helper: could not find a docs page for \`${pathname || discussionTitle}\`._`,
    });
    return;
  }

  const excerpt = selectRelevantMarkdown(doc.markdown, commentBody);
  const ai = new GoogleGenAI({ apiKey: geminiKey });

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      `Page path: /${pathname}/`,
      `Source file: ${doc.file}`,
      `Discussion title: ${discussionTitle}`,
      "",
      "## Page markdown",
      excerpt,
      "",
      "## Question",
      commentBody,
    ].join("\n"),
    config: {
      temperature: 0.2,
      maxOutputTokens: 700,
      systemInstruction: [
        "You help Vivek Gupta with doubts on his sdeway.com notes.",
        "Answer ONLY from the provided page markdown. If it is not in the page, say so and suggest where on the page to look.",
        "Be concise. Use markdown. Quote short snippets when useful.",
        "Do not invent APIs, files, or steps that are not in the page.",
      ].join(" "),
    },
  });

  const answer = (response.text || "").trim();
  if (!answer) throw new Error("Gemini returned an empty reply");

  await postReply(token, {
    discussionId,
    replyToId,
    body: `${answer}\n\n---\n_Answered from \`${doc.file}\`._`,
  });

  console.log(`Replied on ${doc.file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
