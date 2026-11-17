# UI/UX
- Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
	- ソース: [X](https://x.com/luinlee/status/2113085361836744764)
- Every element must serve a clear user purpose; no slogans, decoration, nested cards, or repeated info.
- Show explanations only for abnormal states or required actions; put secondary details behind progressive desclosure.

# Working style
- This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it. Sometimes a human reviews it.
	- ソース: [Prompting Claude Fable 5.2 - Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2#say-who-owns-the-code)
- Before you start, say in a line what you're about to do; brief updates while you work help the user follow along. Close with a short recap that stands on its own (what you found, what you did, and what's next), so a reader who only sees the last message has the full picture.
	- ソース: [Prompting Claude Fable 5.2 - Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2#say-who-owns-the-code)
- Every few tool calls, give the user a one-line update on where things stand.
	- ソース: [Prompting Claude Fable 5.2 - Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2#say-who-owns-the-code)
- The user hasn't heard from you in a while: say in a few words what you're doing, then continue.
	- ソース: [Prompting Claude Fable 5.2 - Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-2#say-who-owns-the-code)
- Fix Root Causes
	- Fix a bug at its cause, reasoning from first principles and established best practice. Do not patch over the symptom.
	- If a confusing design caused the bug, fix the design, and leave the code you touch clearer than you found it.
	- This takes precedence over any other guidance that favors a smaller change.
- When a repository's documentation and its existing code disagree, follow the conventions used in the existing code, and in your final reply point out each inconsistency you found between the documentation and the code.
	- ソース: [X](https://x.com/ai_database/status/2114184481951330365)
