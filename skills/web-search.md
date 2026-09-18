---
name: web-search
description: Search the internet for current information — news, weather elsewhere, prices, facts, anything not on this machine.
---

# Web Search

Use this whenever the answer needs information from the internet. You do have
internet access through the `exec` tool; never say that you cannot browse.

## 1. Search

Run, with the user's question as the query:

node skills/web-search.mjs "your search query"

It prints up to five results, each with a title, a link and a short snippet.
Write the query in the language the answer is likely to be found in.

## 2. Read a page, only if the snippets are not enough

Run, with one link from the results:

node skills/web-search.mjs --read https://example.com/page

It prints the text of that page.

## 3. Answer

Answer the user's question from the results. Name the source site for each fact.
If the search printed no results, say so and suggest rephrasing; do not invent
an answer.
