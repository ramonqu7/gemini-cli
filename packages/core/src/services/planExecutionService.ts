/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Status of an individual plan step.
 */
export type PlanStepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'skipped'
  | 'failed';

/**
 * Represents a single step in an execution plan.
 */
export interface PlanStep {
  index: number;
  description: string;
  status: PlanStepStatus;
  result?: string;
}

/**
 * Overall status of the execution plan lifecycle.
 */
export type ExecutionPlanStatus =
  | 'planning'
  | 'approved'
  | 'executing'
  | 'completed';

/**
 * Represents a full execution plan with its steps and lifecycle state.
 */
export interface ExecutionPlan {
  goal: string;
  steps: PlanStep[];
  currentStep: number;
  status: ExecutionPlanStatus;
}

/**
 * Regex pattern to match numbered plan steps.
 * Matches patterns like:
 *   1. Do something
 *   2) Do something else
 *   3 - Another step
 *   - Bullet point (with implicit numbering)
 */
const NUMBERED_STEP_PATTERN = /^\s*(\d+)\s*[.):-]\s+(.+)/;
const BULLET_STEP_PATTERN = /^\s*[-*]\s+(.+)/;

/**
 * Service that manages the lifecycle of a structured execution plan.
 *
 * The plan execution cycle is:
 *   1. planning  - Model produces a numbered plan from the user's task
 *   2. approved  - User reviews and approves the plan
 *   3. executing - Steps are executed one-by-one with user approval between each
 *   4. completed - All steps done (or plan abandoned)
 *
 * This service is stateful and tracks the current plan across turns.
 * It does NOT auto-advance steps; explicit user approval is required
 * between each step via advanceStep().
 */
export class PlanExecutionService {
  private plan: ExecutionPlan | null = null;
  private autonomous = false;
  private readonly maxAutonomousSteps = 10;

  /**
   * Enable or disable autonomous execution mode.
   * When autonomous, the model executes steps without waiting for user
   * approval between steps, creating checkpoints and running tests after each.
   */
  setAutonomous(value: boolean): void {
    this.autonomous = value;
  }

  /**
   * Returns true if autonomous execution mode is enabled.
   */
  isAutonomous(): boolean {
    return this.autonomous;
  }

  /**
   * Returns the maximum number of steps the model may execute autonomously
   * before pausing for user review.
   */
  getMaxAutonomousSteps(): number {
    return this.maxAutonomousSteps;
  }

  /**
   * Parse a numbered plan from model output text.
   *
   * Looks for lines matching patterns like "1. Do something" or "- Do something"
   * and extracts them as plan steps. The goal is inferred from the first
   * non-step line or defaults to "Execute plan".
   *
   * @param modelOutput - The raw text output from the model containing a plan
   * @param goal - Optional explicit goal description
   * @returns The parsed ExecutionPlan in 'planning' status
   */
  parsePlan(modelOutput: string, goal?: string): ExecutionPlan {
    const lines = modelOutput.split('\n');
    const steps: PlanStep[] = [];
    let inferredGoal = goal ?? '';

    for (const line of lines) {
      const numberedMatch = line.match(NUMBERED_STEP_PATTERN);
      if (numberedMatch) {
        steps.push({
          index: steps.length + 1,
          description: numberedMatch[2].trim(),
          status: 'pending',
        });
        continue;
      }

      const bulletMatch = line.match(BULLET_STEP_PATTERN);
      if (bulletMatch) {
        steps.push({
          index: steps.length + 1,
          description: bulletMatch[1].trim(),
          status: 'pending',
        });
        continue;
      }

      // Use first non-empty, non-step line as the goal if not provided
      if (!inferredGoal && line.trim().length > 0) {
        inferredGoal = line.trim();
      }
    }

    this.plan = {
      goal: inferredGoal || 'Execute plan',
      steps,
      currentStep: 0,
      status: 'planning',
    };

    return this.plan;
  }

  /**
   * Set the plan directly (e.g., from programmatic construction).
   */
  setPlan(plan: ExecutionPlan): void {
    this.plan = plan;
  }

  /**
   * Approve the current plan and transition to 'approved' status.
   * The first step is marked as 'in_progress'.
   *
   * @returns The approved plan, or null if no plan exists
   */
  approvePlan(): ExecutionPlan | null {
    if (!this.plan || this.plan.steps.length === 0) {
      return null;
    }

    this.plan.status = 'approved';
    this.plan.currentStep = 1;
    this.plan.steps[0].status = 'in_progress';
    this.plan.status = 'executing';

    return this.plan;
  }

  /**
   * Mark the current step as complete and advance to the next step.
   *
   * Does NOT auto-start the next step. The next step remains 'pending'
   * until startCurrentStep() is called (which happens after user approval).
   *
   * @param result - Optional result description for the completed step
   * @returns The next PlanStep (still pending), or null if plan is complete
   */
  advanceStep(result?: string): PlanStep | null {
    if (!this.plan || this.plan.status !== 'executing') {
      return null;
    }

    const currentIdx = this.plan.currentStep - 1;
    if (currentIdx < 0 || currentIdx >= this.plan.steps.length) {
      return null;
    }

    // Mark current step as completed
    this.plan.steps[currentIdx].status = 'completed';
    if (result) {
      this.plan.steps[currentIdx].result = result;
    }

    // Move to next step
    const nextIdx = currentIdx + 1;
    if (nextIdx >= this.plan.steps.length) {
      this.plan.status = 'completed';
      this.plan.currentStep = this.plan.steps.length;
      return null;
    }

    this.plan.currentStep = nextIdx + 1;
    // Do NOT auto-set to in_progress; wait for explicit startCurrentStep()
    return this.plan.steps[nextIdx];
  }

  /**
   * Mark the current step as in_progress.
   * Called after user approves proceeding with the next step.
   */
  startCurrentStep(): PlanStep | null {
    if (!this.plan || this.plan.status !== 'executing') {
      return null;
    }

    const currentIdx = this.plan.currentStep - 1;
    if (
      currentIdx < 0 ||
      currentIdx >= this.plan.steps.length
    ) {
      return null;
    }

    this.plan.steps[currentIdx].status = 'in_progress';
    return this.plan.steps[currentIdx];
  }

  /**
   * Mark the current step as failed.
   *
   * @param reason - Why the step failed
   */
  failCurrentStep(reason?: string): void {
    if (!this.plan || this.plan.status !== 'executing') {
      return;
    }

    const currentIdx = this.plan.currentStep - 1;
    if (currentIdx >= 0 && currentIdx < this.plan.steps.length) {
      this.plan.steps[currentIdx].status = 'failed';
      if (reason) {
        this.plan.steps[currentIdx].result = reason;
      }
    }
  }

  /**
   * Skip the current step and advance to the next.
   *
   * @returns The next PlanStep, or null if plan is complete
   */
  skipCurrentStep(): PlanStep | null {
    if (!this.plan || this.plan.status !== 'executing') {
      return null;
    }

    const currentIdx = this.plan.currentStep - 1;
    if (currentIdx < 0 || currentIdx >= this.plan.steps.length) {
      return null;
    }

    this.plan.steps[currentIdx].status = 'skipped';

    const nextIdx = currentIdx + 1;
    if (nextIdx >= this.plan.steps.length) {
      this.plan.status = 'completed';
      this.plan.currentStep = this.plan.steps.length;
      return null;
    }

    this.plan.currentStep = nextIdx + 1;
    return this.plan.steps[nextIdx];
  }

  /**
   * Modify the description of a pending step.
   *
   * @param stepNumber - 1-based step number
   * @param newDescription - The new description for the step
   * @returns true if the step was modified, false if invalid
   */
  modifyStep(stepNumber: number, newDescription: string): boolean {
    if (!this.plan) {
      return false;
    }

    const idx = stepNumber - 1;
    if (idx < 0 || idx >= this.plan.steps.length) {
      return false;
    }

    const step = this.plan.steps[idx];
    if (step.status !== 'pending') {
      return false; // Can only modify pending steps
    }

    step.description = newDescription;
    return true;
  }

  /**
   * Get the current execution plan state.
   *
   * @returns The current ExecutionPlan, or null if no plan exists
   */
  getState(): ExecutionPlan | null {
    return this.plan;
  }

  /**
   * Check whether a plan is currently active (exists and not completed).
   */
  isActive(): boolean {
    return this.plan !== null && this.plan.status !== 'completed';
  }

  /**
   * Check whether the plan is in executing state.
   */
  isExecuting(): boolean {
    return this.plan !== null && this.plan.status === 'executing';
  }

  /**
   * Format the plan for display with status indicators.
   *
   * Uses:
   *   [check mark] for completed steps
   *   [arrow] for the current in-progress step
   *   [circle] for pending steps
   *   [skip] for skipped steps
   *   [x] for failed steps
   *
   * @returns Formatted plan string
   */
  formatPlan(): string {
    if (!this.plan) {
      return 'No active plan.';
    }

    const statusIcon = (step: PlanStep): string => {
      switch (step.status) {
        case 'completed':
          return '[completed]';
        case 'in_progress':
          return '[current] ';
        case 'pending':
          return '[pending]  ';
        case 'skipped':
          return '[skipped]  ';
        case 'failed':
          return '[failed]   ';
        default:
          return '  ';
      }
    };

    const lines: string[] = [];
    lines.push(`Plan: ${this.plan.goal}`);
    lines.push(`Status: ${this.plan.status}`);
    lines.push('');

    for (const step of this.plan.steps) {
      const icon = statusIcon(step);
      let line = `  ${icon} ${step.index}. ${step.description}`;
      if (step.result) {
        line += ` (${step.result})`;
      }
      lines.push(line);
    }

    return lines.join('\n');
  }

  /**
   * Generate a prompt injection for the current step.
   *
   * This is injected into the system prompt when plan execution mode is
   * active, guiding the model to focus on the current step only.
   *
   * @returns A step-scoped prompt string, or empty string if no active step
   */
  getStepPrompt(): string {
    if (!this.plan || this.plan.status !== 'executing') {
      return '';
    }

    const currentIdx = this.plan.currentStep - 1;
    if (currentIdx < 0 || currentIdx >= this.plan.steps.length) {
      return '';
    }

    const currentStep = this.plan.steps[currentIdx];
    const totalSteps = this.plan.steps.length;

    // Build completed steps summary
    const completedSteps = this.plan.steps
      .filter((s) => s.status === 'completed')
      .map((s) => `${s.index}. [completed] ${s.description}${s.result ? ` - ${s.result}` : ''}`)
      .join('\n');

    const skippedSteps = this.plan.steps
      .filter((s) => s.status === 'skipped')
      .map((s) => `${s.index}. [skipped] ${s.description}`)
      .join('\n');

    const pendingSteps = this.plan.steps
      .filter((s) => s.status === 'pending')
      .map((s) => `${s.index}. [pending] ${s.description}`)
      .join('\n');

    const sections: string[] = [
      `You are executing step ${currentStep.index} of ${totalSteps}: "${currentStep.description}"`,
    ];

    if (completedSteps) {
      sections.push(`\nPrevious steps completed:\n${completedSteps}`);
    }

    if (skippedSteps) {
      sections.push(`\nSkipped steps:\n${skippedSteps}`);
    }

    if (pendingSteps) {
      sections.push(`\nUpcoming steps:\n${pendingSteps}`);
    }

    if (this.autonomous) {
      const completedCount = this.plan.steps.filter(
        (s) => s.status === 'completed',
      ).length;
      const remaining = this.maxAutonomousSteps - completedCount;

      sections.push(`
AUTONOMOUS MODE — Execute this step, then:
1. Create a checkpoint (commit current changes).
2. Run the project's test suite to verify your changes.
3. If tests pass: report briefly and proceed to the next step immediately.
4. If tests fail: STOP and explain what went wrong. Do not proceed.
5. After completing ${this.maxAutonomousSteps} steps total (${remaining} remaining), pause for user review regardless of test results.

Do NOT wait for user approval between steps — keep going until tests fail or the step limit is reached.`);
    } else {
      sections.push(
        '\nFocus on THIS step only. When done, report what you accomplished and wait for approval before proceeding.',
      );
    }

    return sections.join('\n');
  }

  /**
   * Reset the plan execution service, clearing all state.
   */
  reset(): void {
    this.plan = null;
    this.autonomous = false;
  }
}
