/**
 * Giscus / GitHub Discussions AI reply (lives in the Giscus repo).
 * Maps discussion pathname → markdown in the checked-out docs repo.
 */
const fs = require("node:fs");
const path = require("node:path");
const { GoogleGenAI } = require("@google/genai");

const ALLOWED_USER = "VivekGupta137";
const MAX_DOC_CHARS = 12_000;
const MODELS = (process.env.GEMINI_MODELS || "gemini-3.7-flash,gemini-3.6-flash,gemini-2.0-flash")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DOCS_ROOT = process.env.DOCS_ROOT || path.join("private-site-code", "src", "content", "docs");

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

async function generateWithFallback(ai, contents, config) {
  const errors = [];

  for (const model of MODELS) {
    const withSearch = { ...config, tools: [{ googleSearch: {} }] };
    try {
      console.log(`Trying Gemini model ${model} (with search)`);
      return await generateOnce(ai, model, contents, withSearch);
    } catch (err) {
      console.warn(`${model} with search failed: ${err.message || err}`);
      errors.push(`${model}+search: ${err.message || err}`);

      if (isSearchUnsupported(err)) {
        try {
          console.log(`Retrying ${model} without search`);
          return await generateOnce(ai, model, contents, config);
        } catch (retryErr) {
          console.warn(`${model} without search failed: ${retryErr.message || retryErr}`);
          errors.push(`${model}: ${retryErr.message || retryErr}`);
          if (!isUnavailable(retryErr)) throw retryErr;
          continue;
        }
      }

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

  const { text: answer, model, response } = await generateWithFallback(ai, contents, {
    temperature: 0.2,
    maxOutputTokens: 900,
    systemInstruction: [
      "You help Vivek Gupta with doubts on his sdeway.com notes.",
      "Prefer the provided page markdown. If it answers the question, quote a short snippet and cite the section heading.",
      "If the page does not contain the answer, use Google Search. Say that it is not on the page, then answer from the web and include source URLs.",
      "Be concise. Use markdown. Do not invent commands or APIs.",
    ].join(" "),
  });

  const sources = webSourceLinks(response);
  const footer = sources.length
    ? `_Gemini \`${model}\` · \`${doc.file}\` · web_\n\n${sources.join(" · ")}`
    : `_Gemini \`${model}\` · \`${doc.file}\`_`;

  await postReply(token, {
    discussionId,
    replyToId,
    body: `${answer}\n\n---\n${footer}`,
  });

  console.log(`Replied on ${doc.file} with ${model}${sources.length ? " + web" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
