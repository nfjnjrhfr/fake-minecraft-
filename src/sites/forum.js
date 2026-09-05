import { createSite, html, escapeHtml } from '../site.js';

/** Mutable state: posting to the forum from the CLI really does change it. */
export function createForum() {
  const threads = [
    {
      id: 1,
      title: 'Creeper took the whole east wall again',
      author: 'stonebrick',
      posts: [
        { author: 'stonebrick', text: 'Third time this week. The wall is now a suggestion.' },
        { author: 'catlady_77', text: 'Get a cat. Two cats. This is not a joke, they are terrified of cats.' },
        { author: 'stonebrick', text: 'I have a cat. The cat was also in the wall.' },
      ],
    },
    {
      id: 2,
      title: 'My 4Hz redstone computer finally boots',
      author: 'tickrate',
      posts: [
        { author: 'tickrate', text: 'Eleven months. It adds two four-bit numbers. I have never been happier.' },
        { author: 'diggy', text: 'How big is it' },
        { author: 'tickrate', text: 'It is a mountain. The mountain is the computer.' },
      ],
    },
    {
      id: 3,
      title: 'PSA: check your portal arithmetic before you dig',
      author: 'netherwart',
      posts: [
        { author: 'netherwart', text: 'Divide by eight. Not multiply. I came out inside someone else basement.' },
        { author: 'stonebrick', text: 'That was my basement.' },
      ],
    },
  ];

  const byId = (id) => threads.find((thread) => thread.id === Number(id));

  const threadView = (thread) => `
    <title>${escapeHtml(thread.title)}</title>
    <h1>${escapeHtml(thread.title)}</h1>
    <p><small>started by ${escapeHtml(thread.author)} · ${thread.posts.length} posts</small></p>
    ${thread.posts
      .map(
        (post) =>
          `<blockquote>${escapeHtml(post.text)}</blockquote><p><small>— ${escapeHtml(post.author)}</small></p>`,
      )
      .join('')}
    <hr>
    <p><a href="/">All threads</a> · <a href="http://www.mine.net/">Front page</a></p>
    <p><small>Reply from the CLI: <code>net post ${thread.id} "your name" "your reply"</code></small></p>`;

  return createSite({
    hostname: 'forum.mine.net',
    title: 'The Deep Slate Forum',
    tagline: 'Complaints, mostly',
    index: [
      { path: '/', title: 'The Deep Slate Forum' },
      ...threads.map((thread) => ({ path: `/threads/${thread.id}`, title: thread.title })),
    ],
    routes: {
      '/': () => `
        <title>The Deep Slate Forum</title>
        <h1>The Deep Slate Forum</h1>
        <ul>
          ${threads
            .map(
              (thread) =>
                `<li><a href="/threads/${thread.id}">${escapeHtml(thread.title)}</a> — <small>${
                  thread.posts.length
                } posts, by ${escapeHtml(thread.author)}</small></li>`,
            )
            .join('')}
        </ul>
        <p><a href="http://www.mine.net/">Front page</a></p>`,

      '/threads/:id': (request, { id }) => {
        const thread = byId(id);
        if (!thread) return html('<h1>No such thread</h1><p><a href="/">All threads</a></p>', { status: 404 });

        if (request.method === 'POST') {
          const author = String(request.body?.author ?? 'anonymous').slice(0, 40);
          const text = String(request.body?.text ?? '').trim();
          if (!text) return html('<h1>400</h1><p>An empty reply is still an empty reply.</p>', { status: 400 });
          thread.posts.push({ author, text });
          return html(threadView(thread), { status: 201 });
        }

        return threadView(thread);
      },
    },
  });
}
