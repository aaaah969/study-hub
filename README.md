# Study Hub

An AI study companion for your college courses.

- **Summaries**: drop in lecture files (PDF, Word, PowerPoint, text, photos) and get short, simple summaries with key points, formulas, key terms and exam tips.
- **Practice tests**: add past exams or question sheets. Study Hub works out their question types and level, then writes new tests in the same style. Multiple choice and true/false are marked instantly; written answers get AI grading with partial credit and feedback. Missed topics become weak topics you can drill.
- **Assignments**: upload or paste an assignment and get a full step-by-step solution that explains each step, plus follow-up questions.
- **Study plan**: a day-by-day plan (up to 29 days) that finishes every course before its exam.
- **Dashboard**: exam readiness, countdowns, plan progress, test scores and streak.

## Run it

You need [Node.js](https://nodejs.org/) 18 or newer and an [Anthropic API key](https://console.anthropic.com/).

```bash
git clone https://github.com/aaaah969/study-hub.git
cd study-hub
cp .env.example .env      # then paste your key into .env
npm start
```

Open http://localhost:3000. There are no packages to install.

Your data is saved in `data/db.json` (ignored by git). The browser also keeps a backup copy.

## Work on it with Claude Code

```bash
cd study-hub
claude
```

`CLAUDE.md` explains the project layout to Claude Code.
