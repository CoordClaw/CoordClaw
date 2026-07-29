# CoordClaw Getting Started Tutorial

This tutorial walks you through the complete flow—from installing CoordClaw to dispatching your first task to the AI team—using a series of screenshots.

> **Important prerequisite**: Before installing CoordClaw, the host software (OpenClaw or one of its variants, such as qclaw) **must be opened and its environment initialized first**; otherwise CoordClaw will not be able to detect the host software.

---

## Step 1: Install CoordClaw

Double-click `start.bat` at the repository root to begin installing CoordClaw.

![Step 1: Double-click start.bat to install CoordClaw](getting_tarted_tutorial/S1.png)

Web dependencies are downloaded and installed automatically during setup.

![Step 1.1: CoordClaw dependencies are installed automatically](getting_tarted_tutorial/S1_1.png)

---

## Step 2: Open the Control Panel

Once installation finishes and the service starts, open the panel URL in your browser:

```
http://localhost:18790
```

![Step 2: Open the panel URL in the browser after installation](getting_tarted_tutorial/S2.png)

---

## Step 3: Enter the Installation Wizard

The first launch automatically redirects to the installation page (`install.html`). Choose the interface language, then click **Next**.

![Step 3: Choose the language on the install page and click Next](getting_tarted_tutorial/S3.png)

---

## Step 4: Select the Host Platform to Install

The wizard scans the user's home directory for discovered OpenClaw instances. Check the host platform(s) you want CoordClaw to connect to, then click **Install**.

![Step 4: Check the host software to install, then click Install](getting_tarted_tutorial/S4.png)

---

## Step 5: Finish Installation and Enter CoordClaw

After installation, the page prompts you to "restart OpenClaw (or the variant) before entering." Open the host software first, then click **Enter CoordClaw**.

![Step 5: Open the host software, then click Enter CoordClaw](getting_tarted_tutorial/S5.png)

---

## Step 6: Launch the Host Software and Load CoordClaw

Taking OpenClaw as an example, once the host software starts it automatically loads the CoordClaw plugin system.

![Step 6: Open the host software; CoordClaw loads automatically](getting_tarted_tutorial/S6.png)

Wait for the Gateway to finish starting; once the log shows `Gateway ready`, you can enter the control panel.

![Step 6.1: Host software started and CoordClaw fully loaded](getting_tarted_tutorial/S6_1.png)

---

## Step 7: Create a New Project

After entering the control panel, wait for the "Data Stream" and "Gateway" indicator lights in the top-right corner to turn green, then click **New Project** on the left.

![Step 7: Enter the control panel, then click New Project once the lights turn green](getting_tarted_tutorial/S7.png)

Follow the wizard to fill in the project name, choose a team template, and specify the project path to complete project creation.

---

## Step 9: View the Current Project and Team Structure

On the current project page you can see basic project info, the member list, token usage, and more. Click the organization-chart icon next to the member count to view the team structure.

![Step 9.1: Current project page—project info, member list, and language switch](getting_tarted_tutorial/S9_1.png)

![Step 9.2: Team organization chart](getting_tarted_tutorial/S9_2.png)

> Click the language switch button at the top to toggle between the Chinese and English interface.

---

## Step 10: Dispatch a Task and Kick Off Team Collaboration

Once the team is ready, you can dispatch your first task.

![Step 10: Choose sender identity and recipient, then send a task to the team](getting_tarted_tutorial/S10.png)

### 10.1 Select a Recipient

In the message input area, select the member who should receive the message.

![Step 10.1: Select a recipient](getting_tarted_tutorial/S10_1.png)

### 10.2 Enter the Task

Select the sender identity (e.g., "Manager Wang / CEO") and the recipient (e.g., "Chen Mo / Product Manager"), type the task description, and send.

![Step 10.2: Select sender and recipient, then enter the task](getting_tarted_tutorial/S10_2.png)

### 10.3 The Agent Starts Responding

After the message is sent, the Agent reads the unread messages and begins working. For example, the Product Manager may reply with requirement clarifications.

![Step 10.3: The Agent replies with requirement clarifications](getting_tarted_tutorial/S10_3.png)

### 10.4 Confirm Requirements with the User

You can reply directly to confirm the Agent's clarifying questions. The "token usage" icon in the interface is clickable to view statistics charts (figures are based on CoordClaw's own algorithm and are for reference only).

![Step 10.4: User confirms requirements; token usage can be viewed](getting_tarted_tutorial/S10_4.png)

### 10.5 Token Usage Statistics

After clicking the token usage icon, you can view a visualization chart and a detailed table of the project's token consumption.

![Step 10.5: Project token usage statistics—visualization chart](getting_tarted_tutorial/S10_5.png)

![Step 10.7: Project token usage statistics—detail table](getting_tarted_tutorial/S10_7.png)

### 10.8 Project Directory Structure

CoordClaw generates a standardized working directory under the project folder: `.data`, `01-review`, `02-formal`, `03-archive`, `04-code`, `temp`, `worklog`, and `Project Charter.md`.

![Step 10.8: Project directory structure](getting_tarted_tutorial/S10_8.png)

### 10.9 Agent Work Records

Each Agent generates a task list (`tasklist-*.md`) and a work log (`worklog-*.md`) under `worklog/<member name>/`.

![Step 10.9: Agent working directory](getting_tarted_tutorial/S10_9.png)

### 10.10 Work Log Example

Open a work log to see the Agent's structured records of task objectives, current stage, next actions, and so on.

![Step 10.10: Agent work log example](getting_tarted_tutorial/S10_10.png)

### 10.11 Review Directory

Formal documents produced by Agents, such as the PRD, go into the `01-review/<member name>/` directory, with version iterations preserved.

![Step 10.11: PRD versions in the review directory](getting_tarted_tutorial/S10_11.png)

### 10.12 Final Deliverable Example

As multi-round collaboration progresses, the team ultimately produces complete deliverables—for example, the following Product Requirements Document (PRD).

![Step 10.12: Final PRD document produced](getting_tarted_tutorial/S10_12.png)

---

## Summary

Through the steps above, you have completed:

1. Installing and initializing CoordClaw
2. Connecting the host software (OpenClaw / variant)
3. Creating your first project
4. Dispatching a task to the AI team and observing the collaboration

You can continue to watch the message stream, toggle message read/unread states, assume any member's identity to intervene, or customize team behavior by editing `team.json`, `team RULE.md`, and `teamsoul.md`.
