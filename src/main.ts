import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import { context } from '@actions/github';


const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

// async function getPRDetails(): Promise<PRDetails> {
//   const { repository, number } = JSON.parse(
//     readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
//   );
//   const prResponse = await octokit.pulls.get({
//     owner: repository.owner.login,
//     repo: repository.name,
//     pull_number: number,
//   });
//   return {
//     owner: repository.owner.login,
//     repo: repository.name,
//     pull_number: number,
//     title: prResponse.data.title ?? "",
//     description: prResponse.data.body ?? "",
//   };
// }

// Function for handling pull_request events
async function handlePullRequestEvent(): Promise<PRDetails> {
  log('Handling pull request event')
  const { repository, number } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8"));
  return getPRDetailsFromAPI(repository.owner.login, repository.name, number);
}

// Function for handling workflow_dispatch events
async function handleWorkflowDispatchEvent(): Promise<PRDetails> {
  log('Handling workflow dispatch event')
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const pull_number = context.payload.inputs.pull_number;
  if (!pull_number) {
    throw new Error('Pull request number must be provided for manual triggers.');
  }
  return getPRDetailsFromAPI(owner, repo, pull_number);
}

// Function for handling issue_comment events
async function handleIssueCommentEvent(): Promise<PRDetails | null> {
  log('Handling issue comment event')
  if (!context.payload.issue?.pull_request) {
    console.log('Comment is not on a pull request.');
    return null;
  }
  const commentBody = context.payload.comment?.body.trim();
  if (commentBody !== '/review') {
    console.log('Comment does not contain the trigger keyword.');
    return null;
  }
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const pull_number = context.payload.issue.number;
  return getPRDetailsFromAPI(owner, repo, pull_number);
}

// Centralized API call function
async function getPRDetailsFromAPI(owner: string, repo: string, pull_number: number): Promise<PRDetails> {
  const prResponse = await octokit.pulls.get({ owner, repo, pull_number });
  return {
    owner,
    repo,
    pull_number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

// General function to determine and call the relevant function based on event type
async function getPRDetails(): Promise<PRDetails | null> {
  log('Getting PR details')
  const handlers: { [key: string]: () => Promise<PRDetails | null> } = {
    'pull_request': handlePullRequestEvent,
    'workflow_dispatch': handleWorkflowDispatchEvent,
    'issue_comment': handleIssueCommentEvent
  };

  const handler = handlers[context.eventName];
  if (!handler) {
    throw new Error('Event not supported.');
  }
  return handler();
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  log('getting diff')
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  log('got diff response')
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  log('analyzing code', { chunks: parsedDiff.length })
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${file.to
    }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
      // @ts-expect-error - ln and ln2 exists where needed
      .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
      .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  log('getting AI response')
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      // return JSON if the model supports it:
      ...(OPENAI_API_MODEL === "gpt-4-1106-preview"
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  log('Creating comment')
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

function log(...logData: any[]) {
  console.log('------------\t', ...logData)
}

async function main() {
  let prDetails = await getPRDetails();
  if (!prDetails) {
    throw new Error('Failed to get PR details from context.')
  }

  log("PR details:", prDetails)

  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  log("Event data:", eventData)

  if (["opened", "created", "workflow_dispatch"].includes(eventData.action)) {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
