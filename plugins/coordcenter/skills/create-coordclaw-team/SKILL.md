---
name: create-coordclaw-team
description: |
  A Skill for creating a CoordClaw multi-agent collaborative team. Through an 8-step standardized process, from requirement gathering to team validation, rapidly build a complete AI team.
---

## 🚨 Mandatory Rules

⚠️ **Strictly comply with the following rules; violations are considered serious errors**:

1. **Strictly follow the 8-step process**: Only execute the 8 steps defined by this Skill. Do not execute or mention any steps outside the process.
2. **No unauthorized actions**: Do not add, modify, or delete content without explicit user permission.
3. **Do not mention extra steps**: Do not mention operations such as "creating agent entities" or "extending the Skill" that are outside the process.
4. **No showing off**: Do not add supplementary content such as "additional," "optional," or "suggested" unless explicitly requested by the user.
5. **Script validation is mandatory**: Step 8 must use the verification script in the SKILL directory for final validation. Visual inspection or claims of "confirmed" are prohibited. If errors are found after script validation, they must be fixed and re-validated. Self-assumed completion is strictly forbidden.
6. **Must match the user's language environment**: Respond and generate files in the same language the user uses. Do not use other languages. For example, if the user asks in Chinese, respond in Chinese; if the user asks in English, respond in English.

Violators will be considered in violation of system rules and will be corrected immediately.

---

## Step 1: Requirement Gathering and Team Folder Creation

### 1.1 Ask the user the following questions to collect team creation requirements:

- 1. What is the team name? Prompt the user: It is recommended to use an English name or pinyin to avoid encoding issues, e.g., GameDevTeam, AIResearchTeam.
- 2. What kind of project is this team intended for?
- 3. What scale of project do you expect this team to be adapted to? Prompt the user: It is recommended to configure different teams for different project scales based on actual conditions. It is not advisable to have team configurations that do not match the real project scale.
- 4. How many people do you want on this team? Prompt the user: More team members is not always better; more members may lead to longer project collaboration time because complex processes will consume a large amount of tokens. Therefore, it is recommended to keep it appropriate. Of course, you can also let me configure it based on the project type and scale.
- 5. How should team members address you in their reports? Prompt the user: You can provide a real name or a title, which will be reflected in the organizational structure and used in team group chats.
- 6. **Organizational Structure**: Do you have any special requirements for the organizational structure?
- 7. **Role Assignment**: Do you have any special role arrangements or other position requirements?

**NOTE**:Please output the text issue directly, do not use any questioning tools to ask the user.

### 1.2 Team Directory Initialization

**Please use the verification script in the SKILL directory to initialize the directory:**

```powershell
# Basic usage (using default path)
python "{skill_dir}/scripts/createteam.py" --init <team_name>
```
- Returns the team directory path.


## Step 2: Organizational Structure Design

**The organizational structure design must consider AI characteristics, such as AI's tendency to hallucinate, overconfidence, and blind obedience.**
**Human User**: If the template specifies a human user's name, use that name to refer to the human user; if not specified, use "User" to refer to the human user.
Based on user requirements, design an organizational structure plan and output the following content for user confirmation:

### 2.1 Output Content
- Organizational chart (hierarchical relationships)
- **Role List (Critical)**: Includes agent_id, role name, name, level, type, direct supervisor, direct subordinates
- Reporting line relationships
- Review process
- agent_id is composed of pinyin of the name + English abbreviation of the position + 5 random letters, e.g., chenmo-pm-grdft
- The human user should not appear as a separate row in the organizational structure table. No agent_id, individual characteristics, team rules, or any other attributes should be configured for the human user. The human user should only be reflected in the superior/subordinate relationships of other agents.

### 2.2 Role Name Conventions (Prevent Name Mapping Errors)

**⚠️ Important: Each role must have a unique name**
- Each role must have a human-like name that conforms to the naming customs of the user's language. For Chinese users, use common surnames from the Hundred Family Surnames; for English users, follow common English naming conventions.
- Names should not overlap with names in the template files.
- "Unique position name" means the same position can have multiple members; it is not necessary for each member to correspond to a unique position. Individual uniqueness is distinguished by name and agent_id.

| Rule | Description | Example |
|------|------|------|
| **Uniqueness Principle** | Each role's name must be unique; multiple people sharing the same name is prohibited | ❌ Error: 3 "Module Leads" all named "Zhou Mo"<br>✅ Correct: "Zhou Mo", "Wang Fang", "Li Zhengfang" |
| **Multiple People in Same Position** | Position name is unique | ❌ Error: "Functional Development Engineer A" ~ "Functional Development Engineer F"<br>✅ Correct: 6 development engineers all use "Functional Development Engineer" |


### 2.3 Confirmation Process
- If adjustments are needed, modify according to user feedback
- **Must confirm the uniqueness of names in the role list**
- Only proceed to the next step after the user agrees to the organizational structure plan

**NOTE**:Please output the text issue directly, do not use any questioning tools to ask the user.

---

## Step 3: Generate Directory Structure Configuration (Physical Directory Creation)

- After the user confirms the organizational structure, generate the `dir_structure.json` configuration file and create the physical directory structure.
- The project directory structure should be as simple and practical as possible. **Strictly prohibit making it overly complex**, and provide design rationale.
- The project directory structure must be adapted to the project characteristics. **Strictly prohibit copying sample directory structures**

### 3.1 Generate dir_structure.json

**Description**: dir_structure.json is the configuration file for the physical directory within the team folder, used for automated script verification.
**File Path**: `$teamDir/dir_structure.json`

**File format, content is for reference only, do not copy!**:
```json
{
  "directories": [
    {"name": "01-raw-data", "description": "Raw data storage (unprocessed)"},
    {"name": "02-processed-data", "description": "Processed data (cleaning completed)"},
    {"name": "03-reports", "description": "Report output directory"},
    {"name": "04-archive", "description": "Archive historical versions"},
    {"name": "temp", "description": "Temporary files (clean up after use)"},
    {"name": "worklog", "description": "Work logs and task lists"},
    {"name": "worklog/<name>", "description": "Each member's own work log folder"}
  ]
}
```

**General Directory Description [For reference only, do not copy!]**:

| Directory | Purpose | Operator | Retention Period |
|------|------|------|------|
| `01-raw-data/` | Raw data storage (unprocessed) | Data collector | Long-term |
| `02-processed-data/` | Processed data (cleaning completed) | Data processor | Long-term |
| `03-reports/` | Report output directory | All members | Long-term |
| `04-archive/` | Archive historical versions | PM operation | Permanent |
| `temp/` | Temporary files (clean up after use) | All members | Short-term (≤2 hours) |
| `worklog/` | Work logs and task lists | All members | Long-term |
| `worklog/<name>` | Each member's own work log folder | Member private | Long-term |

**Special Notes**:
- The member folders under the worklog directory must be named using member names
- Do not copy general directories out of laziness; the project directory structure must match the project characteristics, and strictly prohibit overly complex designs
- Design the project structure based on industry, project category, and project scale
- Must include worklog and temp directories

### 3.2 Create Physical Directories

**Use PowerShell to create directories**, and generate the corresponding dir_structure.json file for automated directory structure verification


### 3.3 User Confirmation
- After generation, show the user the `dir_structure.json` content and the created directory tree
- Confirm the directory structure meets project requirements
- Only proceed to the next step after user review and confirmation

**NOTE**:Please output the text issue directly, do not use any questioning tools to ask the user.

---

## Step 4: Generate teamsoul.md (Individual Personality Trait Definition)

After the user confirms the organizational structure, generate the `$teamDir/.data/teamsoul.md` file.
**Strictly prohibit configuring individual personality traits for human users**

### 4.1 Reference Template
**Reference template file**: Use the `scripts/createteam.py` script in the SKILL directory to get the path

```powershell
# Basic usage (using default path)
python "{skill_dir}/scripts/createteam.py" --soul
```
- Returns the team individual trait definition template file `teamsoul.md` path.

### 4.2 File Structure Requirements
Must include the following section markers (used for automated script sectioning):

```markdown
<!-- AGENTS:START <agent_id1>,<agent_id2>,... -->
<!-- AGENTS:END -->

<!-- SECTION:START id=common name="General Rules" -->

## General Personality
### Thinking Paradigm
### Communication Style
### Professional Values

<!-- SECTION:END id=common -->

<!-- SECTION:START id=<agent_id> name="<name>" -->

## Exclusive Personality
### Basic Information
### Personality Profile

<!-- SECTION:END id=<agent_id> -->
```

### 4.3 Exclusive Personality Requirements

- Basic Information: agent_id, name
- Personality Profile: Core traits, thinking style, decision-making style, work principles, language characteristics, professional field, output style


### 4.4 Generation Method
- **Generate in one complete pass**: Integrate all role content and use the `write-file` skill script to write in one go
- **Strictly prohibit multiple appends**: Avoid content truncation or duplication
- **Name consistency check**: Before generation, verify that all role names match the role list

### 4.5 **User Must Confirm**
- After generation, show the user the file path and key content summary
- Explain to the user the design principles of role rules in teamsoul.md
- Prompt the user to confirm whether the member count is consistent
- Prompt the user to confirm whether the role rules are appropriate, and that these role rules are different from what follows
- **Focus on showing the name list, confirming no duplicates, and count consistency**
- **Only proceed to the next step after user review and confirmation**

**NOTE**:Please output the text issue directly, do not use any questioning tools to ask the user.

---

## Step 5: Generate team RULE.md (Team Collaboration and Role Responsibilities)

After the user confirms teamsoul.md, generate the `$teamDir/.data/team RULE.md` file.
**Strictly prohibit configuring team collaboration and role responsibilities for human users**

### 5.1 Core Principles

**Reference template file**: Use the `scripts/createteam.py` script in the SKILL directory to get the path

```powershell
# Basic usage (using default path)
python "{skill_dir}/scripts/createteam.py" --rule
```
- Returns the team collaboration rules template file `team RULE.md` path.

**Placeholders must NOT be replaced**. Strictly prohibit replacing **<#projectroot#>,<#coordclawroot#>** placeholders in the template file. **<#projectroot#>,<#coordclawroot#>** are runtime placeholders and should be kept as-is during the generation phase.

- **§1 General Team Rules**: Standard actions remain unchanged; organizational relationships are updated
  - In general rules, the general rule description, all-member standard actions, message sending/receiving rules, and conflict resolution subsections must not be modified; directly copy the corresponding content from the reference template file.
  - The team organizational relationship subsection must be updated; all organizational relationship information must fully correspond to the teamsoul.md file.
  - The project directory structure subsection must be adjusted based on industry, project category, and project scale.
  - Code writing rules are specific to the software development industry; other industries must redesign these rules.
  - Based on industry, project category, and project scale, other key general rules may be added.

- **§2 Role Rules**: Must be rewritten based on industry, project category, and project scale
  - Each member's basic information, specific responsibilities, review principles, prohibited items, execution principles
  - Basic information: agent_id, name, level, position, type, direct supervisor, direct subordinates
  - Reference the template file format, but content must be adjusted based on project characteristics


### 5.2 Team Organizational Relationship Generation Standards

**Must strictly follow the following format**:

```markdown
**Team Organizational Relationship [For reference only, do not copy!]**:

| Level | Name | Role/Position | Type | Positioning | Supervisor | Subordinates |
|------|------|------|------|------|------|------|
| L4 | Chen Mo | Product Manager | Decision-maker | Business line top | Director Wang | Zhong Yuan, Fang Heng, Su Xiao, Bai Jin |
| L3 | Zhong Yuan | Architect | Decision-maker | Technical line top | Chen Mo | Lin Rui, Bai Jin, Dai Kexing
| L3 | Fang Heng | Management Expert | Decision-maker | Management line top | Chen Mo | None |
| L2 | Su Xiao | Designer | Executor | Business line execution | Chen Mo | None |
| L2 | Lin Rui | Frontend | Executor | Technical line execution | Zhong Yuan | None |
| L2 | Bai Jin | QA | Executor | Business line execution | Chen Mo, Zhong Yuan | None |
| L1 | Dai Kexing | Backend | Executor | Technical line execution | Zhong Yuan | None |
```

**Key Checkpoints**:
- Member count matches the AGENTS:START list count
- Name column has no duplicate values
- Names and agent_ids are consistent with definitions in teamsoul.md
- Direct supervisor and subordinate relationships are correct (forming a tree structure, no cycles)
- Human user is referred to by their name; strictly prohibit appearing as a separate row, only reflected in the superior/subordinate relationships of other agent members

### 5.3 Team Project Directory Structure Reference [For reference only, do not copy!]
**Note**: This is a software development project structure; other categories of projects must adjust appropriately based on project nature!
**System directory**: Must generate the system directory .data, which stores team configuration files, scripts, and databases.

```markdown
 Directory | Purpose | Operator | Rules |
|------|------|------|------|
| `01-review/` | Project document writing and review | All members | Deliverables go into their own role subdirectory |
| `02-formal/` | Current effective version documents | Moved in after PM review | Moved from 01-review after passing review |
| `03-archive/` | Old version retention | PM operation | Moved in when new version takes effect, note replacement reason |
| `04-code/` | Project code | Code writers | Test code goes into debug folder, release version goes into release folder |
| `worklog/` | Work logs and task lists | All members | Long-term |
| `worklog/<name>` | Each member's own work log folder | Member private | Long-term |
| `temp/` | Temporary files | All members | Clean up after use |
```

### 5.4 File Section Markers

Must include the following section markers (used for automated script sectioning):

```markdown
<!-- HUMAN:START <human_id1>,<human_id2>,... -->
<!-- HUMAN:END -->

<!-- AGENTS:START <agent_id1>,<agent_id2>,... -->
<!-- AGENTS:END -->

<!-- SECTION:START id=common title="General Team Rules" -->
## General Team Rules
<!-- SECTION:START id=teamorganization title="Team Organizational Relationship" -->
### General Team Rules Subsection
<!-- SECTION:END id=teamorganization -->

<!-- SECTION:END id=common -->

<!-- SECTION:START id=individual title="Role Rules" -->

<!-- SECTION:START id=<human_id> role="<position>" name="<name>" -->
### Role Rules Subsection For Human

<!-- SECTION:END id=<human_id> -->

<!-- SECTION:START id=<agent_id> role="<position>" name="<name>" -->
### Role Rules Subsection

<!-- SECTION:END id=<agent_id> -->

<!-- SECTION:END id=individual -->

<!-- SECTION:START id=boundary title="Boundary Rules" -->
<!-- SECTION:END id=boundary -->
```

### 5.5 Generation Strategy (Solving Large File Issues)

Due to large file size (typically 20-35KB), use the following strategies to avoid write errors:

#### Option A: File Splitting (Recommended for teams with 15+ roles)
- Use the `write-file` skill's `write_file.py` script to write multiple temporary files, then merge the temporary files using a Python script
- **Strictly prohibit** using the built-in `write` tool for multiple appends


#### Option B: Single Complete Write (Suitable for teams with 10 or fewer roles)
- Assemble complete content in memory first
- Use the `write-file` skill's `write_file.py` script to write in one go
- **Strictly prohibit** using the built-in `write` tool for multiple appends

### 5.6 Post-Generation Validation (Add Name Mapping Check)

After file generation, the following checks must be performed:

| Check Item | Method | Pass Standard |
|------|------|------|
| File size | View file properties | Meets expectations (compared with estimate, difference < 10%) |
| Key sections | Search for section markers | `§1 General Team Rules` exists and is non-empty |
| Standard actions | Search for `T1/T2/T3/T4/T5` | Table is complete, command format is correct |
| **Name Uniqueness** | Extract name column from role parameter table | **No duplicate names** |
| **Two-file Consistency** | Compare teamsoul.md and team RULE.md | **Names are completely consistent** |
| Role rules | Search for `§2.` | Contains all roles (count matches) |
| Section markers | Search for `<!-- SECTION:` | All markers appear in pairs |
| Organizational relationship | Search for `<!-- AGENTS:START` | Member row count must match AGENT:START list count |
| Encoding format | File properties | UTF-8 with BOM (Windows) |

### 5.7 Error Handling

If any of the following are found, a complete regeneration is required; attempting to fix is prohibited:
- Content loss or truncation
- Section duplication
- Format errors
- Section marker mismatches
- **Name duplicates or mapping errors**
- **teamsoul.md and team RULE.md name inconsistencies**
- **Inconsistencies with sample file structure**

**Prohibited**: Incremental fixes on corrupted files

### 5.8 **User Must Confirm**
- After generation, show the user the file path and key content summary
- Explain to the user the difference between role rules in teamsoul.md and role rules in team RULE.md: one is personal traits, the other is team collaboration requirements
- Explain the purpose of general rules to the user, and prompt the user to check whether the general rules organizational relationships are correct
- Prompt the user to confirm whether the role rules are appropriate, and that these role rules are different from what follows
- Prompt the user to check whether the role rules count matches the organizational relationship table member count
- **Only proceed to the next step after user review and confirmation**

**NOTE**:Please output the text issue directly, do not use any questioning tools to ask the user.

---

## Step 6: Generate Project Charter

Based on user requirements, generate the Project Charter file in the project root directory.

### 6.1 Content Scope
- A project development full process that matches the project characteristics, only listing core processes, including key checkpoints where the human user needs to participate.
- Strictly prohibit writing detailed content; keep content to around 30 lines.

### 6.2 Generation Method
- Write based on team characteristics and project requirements
- Use the `write-file` skill script to write in one go

## Step 7: Generate Member Prompt File roleprompt.json


Based on project characteristics, role characteristics, and position requirements, generate the `$teamDir/.data/roleprompt.json` file in the project directory.

**Reference template file**: Use the `scripts/createteam.py` script in the SKILL directory to get the path

```powershell
# Basic usage (using default path)
python "{skill_dir}/scripts/createteam.py" --roleprompt
```
- Returns the team collaboration rules template file `roleprompt.json` path.

### 7.1 Content Scope
- Role wake-up prompt: A standardized prompt message sent to the role at the beginning of each session to ensure it stably executes tasks according to role conventions. Design principles: Consider the role's conventions and core position responsibilities, whether it is a decision-maker or executor, technical or managerial, reviewer or producer, thinker or doer.
- Role message personalized splicing content: Used to append to the message content sent by the role, so that the message recipient has a fixed reaction to the role, e.g.: 1. Decision-makers should not believe executors; executor messages can be appended with "The information I have may not be accurate; please review item by item according to the programmatic document." 2. Executors must execute according to the programmatic document; decision-maker messages can be appended with "Please execute tasks according to the programmatic document; report any questions or contradictions promptly." The programmatic document is industry-specific; for example, the software industry uses PRD as the programmatic document.

### 7.2 Generation Method
- Write based on team characteristics and project requirements
- Use the `write-file` skill script to write in one go

### 7.3 **User Must Confirm**
- After generation, show the user the file path and key content summary
- Explain to the user the design principles, rationale, and purpose of roleprompt.json
- Prompt the user whether any content needs to be modified
- **Only proceed to the next step after user review and confirmation**

**NOTE**:Please output the text issue directly, do not use any questioning tools to ask the user.

## Step 8: Final Verification (Must Use Script Verification)

### 8.1 Use Verification Script (Mandatory)

**Important: This step must use script verification; visual inspection or claims of "confirmed" are prohibited!**

**After all files are generated, the final verification script must be run:** The script is located in the SKILL directory; do not look in other directories, it is not in the team directory!!

```powershell
# Basic usage (using default path)
python "{skill_dir}/scripts/createteam.py" --verify <team_name>
```

**All warnings and errors after verification must be fully addressed**