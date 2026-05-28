/**
 * chunker.ts — Semantic text chunking for RAG (Retrieval-Augmented Generation).
 *
 * Splits DocumentSection arrays (or plain text) into overlapping token-bounded
 * chunks suitable for embedding and vector search.
 *
 * No heavyweight tokenizer dependency: token count is estimated via a word-based
 * heuristic (1 token ≈ 0.75 words), which is accurate enough for Spanish/English
 * mixed text and avoids pulling in tiktoken / GPT-2 as a runtime dependency.
 */

// ---------------------------------------------------------------------------
// DocumentSection — import from docParser when that module is available.
// Defined inline here to keep chunker.ts independently compilable.
// ---------------------------------------------------------------------------
interface DocumentSection {
  sectionPath: string;
  text: string;
  pageStart?: number;
  pageEnd?: number;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Chunk {
  /** Zero-based, globally incremental index across all sections. */
  chunkIndex: number;
  /** Dot-separated heading path, e.g. "1.2.3 Introduction". */
  sectionPath: string;
  pageStart?: number;
  pageEnd?: number;
  /** Estimated token count of `content`. */
  tokenCount: number;
  /** The actual text content of the chunk. */
  content: string;
  /** Arbitrary metadata for downstream consumers. */
  metadata: Record<string, unknown>;
}

export interface ChunkingOptions {
  /** Maximum estimated tokens per chunk. Default: 800. */
  maxTokens?: number;
  /** Token overlap carried from the end of the previous chunk. Default: 120. */
  overlap?: number;
  /** Discard chunks whose estimated token count is below this threshold. Default: 50. */
  minChunkTokens?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS       = 800;
const DEFAULT_OVERLAP          = 120;
const DEFAULT_MIN_CHUNK_TOKENS = 50;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Estimates the number of tokens in `text`.
 * Approximation: 1 token ≈ 0.75 words for Spanish/English mixed text.
 * This avoids adding tiktoken/GPT-2 tokenizer dependencies.
 */
function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return Math.ceil(trimmed.split(/\s+/).length / 0.75);
}

/**
 * Extracts the last `tokenCount` tokens (word groups) from `text` to use as
 * overlap prefix for the next chunk.
 */
function extractOverlapSuffix(text: string, tokenCount: number): string {
  if (tokenCount <= 0) return "";
  const words = text.trim().split(/\s+/);
  // Convert token budget back to an approximate word count.
  const wordCount = Math.floor(tokenCount * 0.75);
  if (wordCount >= words.length) return text.trim();
  return words.slice(words.length - wordCount).join(" ");
}

/**
 * Splits `text` into two parts such that the first part has approximately
 * `maxTokens` tokens, preferring to break at the last sentence boundary
 * (`.`, `!`, `?`, or blank line) found within the trailing 10 % of the limit.
 *
 * Returns [head, tail].  `tail` may be empty if the whole text fits.
 */
export function splitAtSentenceBoundary(
  text: string,
  maxTokens: number,
): [string, string] {
  // Convert token budget to an approximate character budget.
  // Average English/Spanish word ≈ 5.5 characters + 1 space ≈ 6.5 chars.
  // 1 token ≈ 0.75 words, so 1 token ≈ 0.75 * 6.5 ≈ 4.9 chars.
  const approxCharBudget = Math.floor(maxTokens * 4.9);

  if (approxCharBudget >= text.length) {
    return [text, ""];
  }

  // Tolerate searching for a sentence boundary within the last 10 % of the budget.
  const searchFrom = Math.floor(approxCharBudget * 0.90);
  const searchTo   = approxCharBudget;

  // Prefer blank-line paragraph breaks, then sentence-ending punctuation, then
  // bare newlines (preserves CSV/tabular row boundaries).
  const window = text.slice(searchFrom, searchTo + 1);

  // Blank line (paragraph separator) — highest priority.
  let boundaryOffset = window.lastIndexOf("\n\n");
  if (boundaryOffset !== -1) {
    const cutPos = searchFrom + boundaryOffset + 2; // include the blank line
    return [text.slice(0, cutPos).trimEnd(), text.slice(cutPos).trimStart()];
  }

  // Sentence-ending punctuation followed by whitespace.
  const sentenceRegex = /[.!?](?=\s)/g;
  let bestMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = sentenceRegex.exec(window)) !== null) {
    bestMatch = m;
  }
  if (bestMatch !== null) {
    const cutPos = searchFrom + bestMatch.index + 1; // include the punctuation
    return [text.slice(0, cutPos).trimEnd(), text.slice(cutPos).trimStart()];
  }

  // Single newline (respects CSV/tabular rows).
  boundaryOffset = window.lastIndexOf("\n");
  if (boundaryOffset !== -1) {
    const cutPos = searchFrom + boundaryOffset + 1;
    return [text.slice(0, cutPos).trimEnd(), text.slice(cutPos).trimStart()];
  }

  // Hard cut at the character budget as a last resort.
  return [text.slice(0, approxCharBudget).trimEnd(), text.slice(approxCharBudget).trimStart()];
}

/**
 * Splits a single section's text into chunks, respecting `maxTokens` and
 * generating `overlap`-token prefixes for each subsequent chunk.
 *
 * Returns raw content strings (caller assigns global `chunkIndex`).
 */
function splitSectionText(
  text: string,
  maxTokens: number,
  overlap: number,
): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  let overlapPrefix = "";

  // Guard against pathologically large sections (> 10x maxTokens): the
  // recursive splitting logic below naturally handles this, but we add an
  // iteration cap to prevent infinite loops on degenerate input.
  const MAX_ITERATIONS = 10_000;
  let iterations = 0;

  while (remaining.length > 0 && iterations < MAX_ITERATIONS) {
    iterations++;

    const candidate = overlapPrefix.length > 0
      ? overlapPrefix + " " + remaining
      : remaining;

    const candidateTokens = estimateTokens(candidate);

    if (candidateTokens <= maxTokens) {
      // Everything fits in one chunk.
      chunks.push(candidate.trim());
      break;
    }

    // Split at a sentence boundary.
    const [head, tail] = splitAtSentenceBoundary(candidate, maxTokens);

    if (head.length === 0) {
      // Degenerate: splitAtSentenceBoundary returned an empty head (e.g. the
      // very first character is past the budget).  Force a hard split at the
      // budget to guarantee progress.
      const hardCut = Math.floor(maxTokens * 4.9);
      chunks.push(candidate.slice(0, hardCut).trim());
      remaining = candidate.slice(hardCut).trim();
      overlapPrefix = extractOverlapSuffix(chunks[chunks.length - 1]!, overlap);
      continue;
    }

    chunks.push(head.trim());

    // Build overlap from the end of the chunk we just emitted.
    overlapPrefix = extractOverlapSuffix(head, overlap);

    // `remaining` advances past the part already consumed by `head`.
    // We need to figure out how many characters of `remaining` were consumed.
    // Because `candidate = overlapPrefix + " " + remaining` (or just `remaining`),
    // we can derive it from the tail.
    if (tail.length === 0) {
      break;
    }

    // tail contains the unconsumed portion of `candidate`.  We need to strip
    // the overlap prefix portion from it so `remaining` only moves forward.
    // Strategy: find where `tail` starts within the original `remaining`.
    const overlapPrefixLen = overlapPrefix.length > 0 ? overlapPrefix.length + 1 : 0;
    const tailInCandidate = candidate.length - tail.length;
    const newRemainingStart = tailInCandidate - overlapPrefixLen;
    remaining = remaining.slice(Math.max(0, newRemainingStart)).trim();

    if (remaining.length === 0) break;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Segments an array of `DocumentSection` objects into token-bounded, overlapping
 * `Chunk` objects suitable for embedding.
 *
 * Sections smaller than `minChunkTokens` are merged with the following section
 * before splitting, so short headings/captions are not emitted as standalone chunks.
 */
export function chunkSections(
  sections: DocumentSection[],
  options?: ChunkingOptions,
): Chunk[] {
  const maxTokens       = options?.maxTokens       ?? DEFAULT_MAX_TOKENS;
  const overlap         = options?.overlap         ?? DEFAULT_OVERLAP;
  const minChunkTokens  = options?.minChunkTokens  ?? DEFAULT_MIN_CHUNK_TOKENS;

  if (sections.length === 0) return [];

  // --- Step 1: merge tiny sections into their successor -------------------
  const merged: DocumentSection[] = [];
  let pending: DocumentSection | null = null;

  for (const section of sections) {
    if (pending !== null) {
      const combined: string = pending.text.trim() + "\n\n" + section.text.trim();
      pending = {
        sectionPath: pending.sectionPath,          // keep the first path
        text: combined,
        pageStart: pending.pageStart,
        pageEnd: section.pageEnd ?? pending.pageEnd,
      };
      if (estimateTokens(pending.text) >= minChunkTokens) {
        merged.push(pending);
        pending = null;
      }
      // else: keep accumulating into pending
    } else if (estimateTokens(section.text) < minChunkTokens) {
      // Too small — defer and try to combine with next section.
      pending = { ...section };
    } else {
      merged.push(section);
    }
  }
  // Flush any remaining pending section (even if still tiny).
  if (pending !== null) {
    merged.push(pending);
  }

  // --- Step 2: split each merged section into token-bounded chunks --------
  const result: Chunk[] = [];
  let globalIndex = 0;

  for (const section of merged) {
    const text = section.text.trim();
    if (text.length === 0) continue;

    if (estimateTokens(text) < minChunkTokens) {
      // Still below threshold after merging — discard.
      continue;
    }

    const contentParts = splitSectionText(text, maxTokens, overlap);

    for (const content of contentParts) {
      if (content.length === 0) continue;
      const tokenCount = estimateTokens(content);
      if (tokenCount < minChunkTokens) continue; // discard runt chunks

      result.push({
        chunkIndex:  globalIndex++,
        sectionPath: section.sectionPath,
        pageStart:   section.pageStart,
        pageEnd:     section.pageEnd,
        tokenCount,
        content,
        metadata: {
          sectionPath:    section.sectionPath,
          pageStart:      section.pageStart,
          pageEnd:        section.pageEnd,
          originalLength: section.text.length,
        },
      });
    }
  }

  return result;
}

/**
 * Convenience wrapper for plain text (no pre-parsed sections).
 * Creates a single synthetic section and delegates to `chunkSections`.
 */
export function chunkText(
  text: string,
  options?: ChunkingOptions,
): Chunk[] {
  if (text.trim().length === 0) return [];

  const syntheticSection: DocumentSection = {
    sectionPath: "root",
    text,
  };

  return chunkSections([syntheticSection], options);
}
