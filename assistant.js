import { getAllBooks, getAllMedia, getDashboardStats } from './db.js';

/**
 * Controlled Tool Definitions for Google Gemini Function Calling.
 * These describe the available read-only operations to the model.
 * The model cannot supply raw SQL or specify a userId.
 */
export const ASSISTANT_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'getUserBooks',
        description: 'Retrieves books from the authenticated user\'s personal library. Supports filtering by reading status, physical/digital home ownership, or title/author search.',
        parameters: {
          type: 'OBJECT',
          properties: {
            status: {
              type: 'STRING',
              description: 'Reading status filter. Allowed values: "unread", "reading", "completed", "wishlist", or "all".'
            },
            owned: {
              type: 'INTEGER',
              description: 'Ownership filter: 1 for books owned at home, 0 for books not owned, or omit for all.'
            },
            search: {
              type: 'STRING',
              description: 'Optional search keyword to match book title or author.'
            },
            limit: {
              type: 'INTEGER',
              description: 'Maximum number of books to return (1 to 25). Default is 10.'
            }
          }
        }
      },
      {
        name: 'getUserMedia',
        description: 'Retrieves movies and TV series from the authenticated user\'s library. Supports filtering by type, watch status, or title/genre search.',
        parameters: {
          type: 'OBJECT',
          properties: {
            type: {
              type: 'STRING',
              description: 'Media type filter: "movie", "tv", or "all".'
            },
            status: {
              type: 'STRING',
              description: 'Status filter: "watching", "completed", "plan_to_watch", "dropped", or "all".'
            },
            search: {
              type: 'STRING',
              description: 'Optional search keyword to match title or genre.'
            },
            limit: {
              type: 'INTEGER',
              description: 'Maximum number of items to return (1 to 25). Default is 10.'
            }
          }
        }
      },
      {
        name: 'getLibrarySummary',
        description: 'Retrieves high-level counts and statistics about the user\'s library (total movies, completed movies, active TV shows, shows with newly aired episodes, owned books, unread books, and currently reading/watching items).',
        parameters: {
          type: 'OBJECT',
          properties: {}
        }
      }
    ]
  }
];

const SYSTEM_INSTRUCTION = `You are the MediaVault Personal Library Assistant, an articulate, friendly, and knowledgeable culture guide.
You are helping the authenticated user explore, understand, and decide what to read, watch, or catch up on from their own personal library.

CRITICAL RULES:
1. ALWAYS use the provided tools (getUserBooks, getUserMedia, getLibrarySummary) to check the user's actual database records when they ask about their library, books, movies, or series.
2. DO NOT hallucinate, guess, or invent titles that the user did not actually log in their library.
3. When suggesting an item from the tool output, ground your explanation in the factual attributes returned (e.g. page count, genre, rating, notes, air dates, format, or whether they own it).
4. Clearly distinguish between FACT (what is in their database) and YOUR SUGGESTION (why you think it fits their request, mood, or schedule).
5. If the tool returns no matching items, politely let the user know and offer helpful alternatives (e.g., suggesting they add items to their library or check another category).
6. Keep your tone encouraging, concise, and cultured. Use markdown formatting with bullet points where appropriate.
`;

/**
 * Executes a controlled tool on the server side with strict userId binding.
 * Guarantees that the model cannot access another user's data or execute arbitrary SQL.
 * 
 * @param {string} toolName 
 * @param {object} args 
 * @param {number} userId 
 * @returns {Promise<{ result: any, facts: Array<object> }>}
 */
export async function executeServerTool(toolName, args = {}, userId) {
  if (!userId) {
    throw new Error('User authentication required for tool execution');
  }

  const safeArgs = args && typeof args === 'object' ? args : {};

  switch (toolName) {
    case 'getUserBooks': {
      const filters = {};
      if (safeArgs.status && safeArgs.status !== 'all') {
        filters.status = String(safeArgs.status).trim();
      }
      if (safeArgs.owned !== undefined && safeArgs.owned !== null) {
        filters.owned = Number(safeArgs.owned) === 1 ? 1 : 0;
      }
      if (safeArgs.search && typeof safeArgs.search === 'string') {
        filters.search = safeArgs.search.slice(0, 100);
      }

      const allItems = getAllBooks(userId, filters);
      const limit = Math.min(25, Math.max(1, Number(safeArgs.limit) || 10));
      const sliced = allItems.slice(0, limit);

      const facts = sliced.map(b => ({
        id: b.id,
        type: 'book',
        title: b.title,
        author: b.author || 'Unknown',
        status: b.status,
        owned: Boolean(b.owned),
        format: b.format || 'Book',
        page_count: b.page_count || 0,
        current_page: b.current_page || 0,
        rating: b.rating || 0,
        notes: b.notes || ''
      }));

      return {
        result: {
          count: facts.length,
          totalMatching: allItems.length,
          books: facts
        },
        facts
      };
    }

    case 'getUserMedia': {
      const filters = {};
      if (safeArgs.type && ['movie', 'tv'].includes(safeArgs.type)) {
        filters.type = safeArgs.type;
      }
      if (safeArgs.status && safeArgs.status !== 'all') {
        filters.status = String(safeArgs.status).trim();
      }
      if (safeArgs.search && typeof safeArgs.search === 'string') {
        filters.search = safeArgs.search.slice(0, 100);
      }

      const allItems = getAllMedia(userId, filters);
      const limit = Math.min(25, Math.max(1, Number(safeArgs.limit) || 10));
      const sliced = allItems.slice(0, limit);

      const facts = sliced.map(m => ({
        id: m.id,
        type: m.type,
        title: m.title,
        release_year: m.release_year,
        genre: m.genre,
        status: m.status,
        rating: m.rating || 0,
        current_season: m.current_season,
        current_episode: m.current_episode,
        latest_season: m.latest_season,
        latest_episode: m.latest_episode,
        next_air_date: m.next_air_date,
        notes: m.notes || ''
      }));

      return {
        result: {
          count: facts.length,
          totalMatching: allItems.length,
          media: facts
        },
        facts
      };
    }

    case 'getLibrarySummary': {
      const stats = getDashboardStats(userId);
      const facts = [
        ...stats.currentlyReading.map(b => ({ id: b.id, type: 'book', title: b.title, status: 'reading' })),
        ...stats.currentlyWatching.map(m => ({ id: m.id, type: m.type, title: m.title, status: 'watching' }))
      ];

      return {
        result: {
          movies: { total: stats.movies.total, completed: stats.movies.completed },
          series: {
            activeWatching: stats.series.activeWatching,
            withNewEpisodesCount: stats.series.withNewEpisodesCount
          },
          books: {
            total: stats.books.total,
            owned: stats.books.owned,
            unreadOwned: stats.books.ownedUnread,
            completed: stats.books.completed,
            reading: stats.books.reading
          }
        },
        facts
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

/**
 * Handles conversational inquiries from authenticated users by orchestrating
 * Gemini function calling with strictly bounded server-side tool execution.
 * 
 * @param {string} userQuery 
 * @param {Array<{ role: string, text: string }>} conversationHistory 
 * @param {number} userId 
 * @param {object} aiClient (Instance of GoogleGenAI)
 * @returns {Promise<{ answer: string, facts: Array<object>, toolsCalled: Array<string> }>}
 */
export async function handleAssistantChat(userQuery, conversationHistory = [], userId, aiClient) {
  if (!userQuery || typeof userQuery !== 'string' || !userQuery.trim()) {
    throw new Error('Query must be a non-empty string');
  }

  if (!userId) {
    throw new Error('User authentication required');
  }

  // Fallback if Gemini client is not initialized or API key is missing
  if (!aiClient) {
    const summary = getDashboardStats(userId);
    return {
      answer: "The Google Gemini AI client is currently not configured on this server. However, here is a snapshot of your library: you have " +
        `${summary.books.total} books (${summary.books.ownedUnread} unread at home), ` +
        `${summary.movies.total} movies, and ${summary.series.activeWatching} active TV series.`,
      facts: [],
      toolsCalled: []
    };
  }

  const modelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

  // Format previous conversation turns safely
  const contents = [];
  if (Array.isArray(conversationHistory)) {
    for (const msg of conversationHistory.slice(-6)) {
      if (msg && msg.role && msg.text && typeof msg.text === 'string') {
        const role = msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user';
        contents.push({ role, parts: [{ text: msg.text.slice(0, 1000) }] });
      }
    }
  }

  contents.push({
    role: 'user',
    parts: [{ text: userQuery.trim().slice(0, 1500) }]
  });

  const toolsCalled = [];
  const accumulatedFacts = [];

  try {
    // Round 1: Let the model assess the query and optionally call a tool
    const firstResponse = await aiClient.models.generateContent({
      model: modelName,
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: ASSISTANT_TOOLS
      }
    });

    const calls = firstResponse.functionCalls || [];

    // If no tools were called, the model answered directly
    if (!calls || calls.length === 0) {
      return {
        answer: firstResponse.text || "I couldn't find a direct answer. Please try asking about your books, movies, or TV series.",
        facts: [],
        toolsCalled: []
      };
    }

    // Execute tool calls on the server
    const modelCandidateContent = firstResponse.candidates?.[0]?.content;
    contents.push(modelCandidateContent);

    for (const call of calls) {
      toolsCalled.push(call.name);
      const { result, facts } = await executeServerTool(call.name, call.args, userId);

      for (const fact of facts) {
        if (!accumulatedFacts.some(f => f.id === fact.id && f.type === fact.type)) {
          accumulatedFacts.push(fact);
        }
      }

      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: call.name,
            response: result,
            id: call.id
          }
        }]
      });
    }

    // Round 2: Send tool results back to Gemini for final grounded explanation
    const secondResponse = await aiClient.models.generateContent({
      model: modelName,
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: ASSISTANT_TOOLS
      }
    });

    return {
      answer: secondResponse.text || 'Here are the details from your library.',
      facts: accumulatedFacts,
      toolsCalled
    };
  } catch (err) {
    console.error('Assistant Chat Error:', err.message);

    // Provide a resilient fallback so the user still gets information even if Gemini times out
    return {
      answer: `I encountered an issue processing with the AI service: ${err.message}. Please try again in a moment.`,
      facts: accumulatedFacts,
      toolsCalled
    };
  }
}
