# Creating a Team Tutorial

This tutorial explains how to quickly create an Agent team ready for immediate project collaboration in CoordClaw using the **AI Team Creation Assistant**.

**Important note**: If the creation process is interrupted, you can close and re-enter it, or go to the host software to continue the conversation, then check progress in the progress bar.

> Prerequisite: You have completed the [Getting Started Tutorial](./getting_tarted_tutorial.en.md) and the control panel has started normally and entered the "Team Collaboration Center."

---

## Step 1: Open the AI Team Creation Assistant

Click the **New Team** button in the left "Team Management" panel to bring up the "AI Team Creation Assistant" dialog.

Describe your creation intent in the input box, for example:

```text
Please create a CoordClaw team.
```

![Open the creation assistant](create_team_tutorial/S1.png)

---

## Step 2: Answer Team Configuration Questions

The assistant asks 7 key pieces of information in turn:

1. Team name (English or pinyin recommended to avoid encoding issues)
2. Project type
3. Project scale (Small / Medium / Large)
4. Team size
5. How you'd like to be addressed
6. Organizational structure requirements
7. Role arrangement requirements

You can delegate the decisions to the assistant, as in the example:

```text
Pick a name for me — a web game production team, medium-sized project. You decide the headcount, and call me Manager Wang. No other special requirements.
```

![Answer the configuration questions](create_team_tutorial/S2.png)

---

## Step 3: Confirm the Role Plan

The assistant proposes a role plan based on your description. In the example, the team is named `WebGameStudio` with a size of 5 members.

Confirm by replying OK once everything looks correct.

![Confirm the role plan](create_team_tutorial/S3.png)

---

## Step 4: Confirm the Detailed Organizational Relationships

The assistant generates a detailed team configuration table, including:

- `agent_id`, name, role/position, level, type
- Direct supervisor, direct subordinates
- Reporting relationship chain

The "Creation Progress" panel on the right shows completed steps in sync:

- Team directory created
- Project structure created
- Member personalization profiles generated
- Team rules file generated
- Team configuration passed verification

![Confirm the organizational relationships](create_team_tutorial/S4.png)

---

## Step 5: Confirm the Project Directory Structure

The assistant suggests a project directory structure, for example:

| Directory | Purpose | Notes |
| :--- | :--- | :--- |
| `01-game-design/` | Game design | PM produces requirement docs and feature planning; the starting point of development |
| `02-art-assets/` | Art assets | Art assets stored separately; referenced during frontend builds for easy management |
| `03-source-code/` | Source code | Frontend and backend code stored together; just separate into subfolders |
| `04-test-reports/` | Test reports | QA produces test cases and reports; separate directory prevents confusion |
| `05-build-output/` | Build output | Release versions archived, separated from source |
| `06-project-docs/` | Project docs | API docs, deployment docs, etc. |
| `temp/` | Temporary | Temporary file exchange between members |
| `worklog/` | Work logs | Each member has an individual log folder |

After confirmation, the assistant generates the real physical directories.

![Confirm the directory structure](create_team_tutorial/S5.png)

---

## Step 6: Confirm Member Personality Profiles (SOUL)

The assistant generates a "personality profile" (SOUL) for each member, including:

- Core traits
- Thinking style
- Decision style
- Working principles
- Areas of expertise

Taking the QA engineer as an example, traits might be "quality gatekeeper, destructive expert, boundary probe, risk-oriented, zero speculation." Confirm whether the name, role traits, and area of expertise are appropriate.

![Confirm the member profile](create_team_tutorial/S6.png)

---

## Step 7: Confirm Collaboration Principles

The assistant summarizes the team's overall design principles, for example:

- **Responsibility boundaries**: Clearly define areas of expertise and working principles to prevent the AI from overstepping into functions outside its role
- **Differentiated apprentices**: The 5 roles have distinct thinking styles and language, with clear division of labor
- **Quality awareness**: QA is independent of development, ensuring testing is not pressured by schedule

After confirmation, the assistant proceeds to the next step: generating the team collaboration rules file `team RULE.md`.

![Confirm the collaboration principles](create_team_tutorial/S7.png)

---

## Step 8: View the Generated Role Definition File `teamsoul.md`

During creation, the assistant generates `teamsoul.md` in the team directory.

This file is the "team role SOUL definition collection," defining each member's working personality, thinking paradigm, and professional values. It **does not contain specific team processes, organizational relationships, or project-specific content**. The deployment script generates an individual `SOUL.md` for each member based on this file.

![teamsoul.md file example](create_team_tutorial/S8.png)

---

## Step 9: Generate the Team Collaboration Rules `team RULE.md`

The assistant writes the team collaboration rules based on the organizational relationships and role requirements, generating `team RULE.md`.

> Tip: This step may involve multiple rounds of tool calls. If the content is long, the assistant automatically switches to a step-by-step writing approach. You can prompt it to review the `create-coordclaw-team` skill steps to ensure the rules match the role requirements.

![Generate team RULE.md](create_team_tutorial/S9.png)

After generation, you can view the full content of `team RULE.md` in a text editor, including version, date, core principles, general team rules, organizational structure, etc.

![team RULE.md file example](create_team_tutorial/S10.png)

---

## Step 10: Complete Team Creation

After confirming all configurations and passing verification, the team registration button becomes available.

![Team creation complete](create_team_tutorial/S11.png)

---

## Step 11: Register the Team

Click the **Register Team** button at the bottom-right. On success, a prompt appears:

```text
Team registered successfully!
```

![Team registered successfully](create_team_tutorial/S12.png)

---

## Next Steps

After the team is registered, return to the "Team Collaboration Center" and refer to the [Getting Started Tutorial](./getting_tarted_tutorial.en.md), "Step 10: Dispatch a Task to the Team," to select a sender and recipient and begin project collaboration.
