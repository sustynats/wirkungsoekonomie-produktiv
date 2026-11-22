// Pure synchronous projections for matching related ticker history. These
// invocation-local sets never outlive the call or affect editorial decisions.
export function storySimilarityFromTokens(left, right) {
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  const containment = shared / Math.min(left.size, right.size);
  return Math.max(shared / union, containment * 0.86);
}

function storyComparisonText(story) {
  return [
    story.title,
    story.analysis?.summary,
    ...(story.sources || []).flatMap((source) => [source.title, source.summary]),
  ].filter(Boolean).join(" ");
}

export function attachRelatedTickerHistory(candidates, stories, tokenize) {
  const publishedHistory = (stories || [])
    .filter((story) => story.published && story.retirement?.reason_code !== "MERGED_INTO_LIVING_FILE");
  // Lazily prepare only records actually compared, preserving the original
  // self-ID filter even when the corpus is empty or contains only this story.
  const historyTokens = new Map();
  return candidates.map((candidate) => {
    const candidateText = storyComparisonText(candidate);
    let candidateTokens;
    const relatedTickerHistory = publishedHistory
      .filter((story) => story.story_id !== candidate.story_id)
      .map((story) => {
        if (!historyTokens.has(story)) historyTokens.set(story, tokenize(storyComparisonText(story)));
        candidateTokens ||= tokenize(candidateText);
        return { story, similarity: storySimilarityFromTokens(candidateTokens, historyTokens.get(story)) };
      })
      .filter(({ similarity }) => similarity >= 0.1)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5)
      .map(({ story }) => ({
        story_id: story.story_id,
        title: story.title,
        summary: story.analysis?.summary || "",
        source_published_at: (story.sources || [])
          .map((source) => source.published_at)
          .filter(Boolean)
          .sort()[0] || story.first_seen,
        source_urls: (story.sources || []).map((source) => source.url).slice(0, 3),
      }));
    return { ...candidate, related_ticker_history: relatedTickerHistory };
  });
}
