/**
 * Giscus / GitHub Discussions AI reply (lives in the Giscus repo).
 * Maps discussion pathname → markdown in the checked-out docs repo.
 */
const fs = require("node:fs");
const path = require("node:path");
const { GoogleGenAI } = require("@google/genai");

const ALLOWED_USER = "VivekGupta137";
const MAX_DOC_CHARS = 12_000;
const MODELS = (process.env.GEMINI_MODELS || "gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash-lite")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DOCS_ROOT = process.env.DOCS_ROOT || path.join("private-site-code", "src", "content", "docs");
const NOT_IN_PAGE = "NOT_IN_PAGE";

const PAGE_INSTRUCTION = [
  "You help Vivek Gupta with doubts on his sdeway.com notes.",
  "Answer ONLY from the provided page markdown. Quote a short snippet and cite the section heading when it answers the question.",
  `If the page does not contain the answer, reply with exactly ${NOT_IN_PAGE} and nothing else.`,
].join(" ");

const WEB_INSTRUCTION = [
  "You help Vivek Gupta with doubts on his sdeway.com notes.",
  "The provided page markdown does not contain the answer. Use Google Search.",
  "Say that it is not on the page, then answer from the web and include source URLs.",
  "Be concise. Use markdown. Do not invent commands or APIs.",
].join(" ");

const KNOWLEDGE_INSTRUCTION = [
  "You help Vivek Gupta with doubts on his sdeway.com notes.",
  "The provided page markdown does not contain the answer, and web search is unavailable.",
  "Answer from your knowledge of the topic. Start by saying it is not on this notes page.",
  "Be concise. Use markdown. Do not invent commands or APIs.",
].join(" ");

function isUnavailable(err) {
  const status = err?.status || err?.code;
  const msg = String(err?.message || err || "");
  return (
    status === 503 ||
    status === 429 ||
    status === 404 ||
    /UNAVAILABLE|RESOURCE_EXHAUSTED|NOT_FOUND|high demand|no longer available/i.test(msg)
  );
}

function isSearchUnsupported(err) {
  const status = err?.status || err?.code;
  const msg = String(err?.message || err || "");
  return status === 400 || /INVALID_ARGUMENT|googleSearch|not supported/i.test(msg);
}

function isMissingFromPage(text) {
  const t = String(text || "")
    .trim()
    .replace(/^`+|`+$/g, "");
  return t === NOT_IN_PAGE || t.startsWith(`${NOT_IN_PAGE}\n`) || t.startsWith(`${NOT_IN_PAGE} `);
}

function webSourceLinks(response) {
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  const links = [];
  for (const chunk of chunks) {
    const uri = chunk.web?.uri;
    const title = (chunk.web?.title || uri || "").replace(/\|/g, " ");
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    links.push(`[${title}](${uri})`);
    if (links.length >= 4) break;
  }
  return links;
}

async function generateOnce(ai, model, contents, config) {
  const response = await ai.models.generateContent({ model, contents, config });
  const text = (response.text || "").trim();
  if (!text) throw new Error("empty reply");
  return { text, model, response };
}

async function generateAnswer(ai, contents, baseConfig) {
  const errors = [];

  for (const model of MODELS) {
    try {
      console.log(`Trying Gemini model ${model} (page)`);
      const page = await generateOnce(ai, model, contents, {
        ...baseConfig,
        systemInstruction: PAGE_INSTRUCTION,
      });
      if (!isMissingFromPage(page.text)) return { ...page, origin: "page" };
    } catch (err) {
      console.warn(`${model} page failed: ${err.message || err}`);
      errors.push(`${model}+page: ${err.message || err}`);
      if (!isUnavailable(err)) throw err;
      continue;
    }

    try {
      console.log(`Trying Gemini model ${model} (search)`);
      const web = await generateOnce(ai, model, contents, {
        ...baseConfig,
        tools: [{ googleSearch: {} }],
        systemInstruction: WEB_INSTRUCTION,
      });
      return { ...web, origin: "web" };
    } catch (err) {
      console.warn(`${model} search failed: ${err.message || err}`);
      errors.push(`${model}+search: ${err.message || err}`);
      if (!isUnavailable(err) && !isSearchUnsupported(err)) throw err;
    }

    try {
      console.log(`Trying Gemini model ${model} (knowledge)`);
      const knowledge = await generateOnce(ai, model, contents, {
        ...baseConfig,
        systemInstruction: KNOWLEDGE_INSTRUCTION,
      });
      return { ...knowledge, origin: "knowledge" };
    } catch (err) {
      console.warn(`${model} knowledge failed: ${err.message || err}`);
      errors.push(`${model}+knowledge: ${err.message || err}`);
      if (!isUnavailable(err)) throw err;
    }
  }

  throw new Error(`All Gemini models failed:\n${errors.join("\n")}`);
}

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
  console.log(`Gemini models: ${MODELS.join(" → ")}`);
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
  const contents = [
    `Page path: /${pathname}/`,
    `Source file: ${doc.file}`,
    `Discussion title: ${discussionTitle}`,
    "",
    "## Page markdown",
    excerpt,
    "",
    "## Question",
    commentBody,
  ].join("\n");

  const { text: answer, model, response, origin } = await generateAnswer(ai, contents, {
    temperature: 0.2,
    maxOutputTokens: 900,
  });

  const sources = origin === "web" ? webSourceLinks(response) : [];
  const originLabel = origin === "web" ? "web" : origin === "knowledge" ? "not on page" : null;
  const footerBits = [`Gemini \`${model}\``, `\`${doc.file}\``];
  if (originLabel) footerBits.push(originLabel);
  const footer = `_${footerBits.join(" · ")}_${sources.length ? `\n\n${sources.join(" · ")}` : ""}`;

  await postReply(token, {
    discussionId,
    replyToId,
    body: `${answer}\n\n---\n${footer}`,
  });

  console.log(`Replied on ${doc.file} with ${model} (${origin})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
