function normalizeMessage(text: string): string {
  return text.trim().toLowerCase().slice(0, 160);
}

interface QuestionStat {
  text: string;
  count: number;
}

export interface AnalyticsSnapshot {
  totalCalls: number;
  totalCallerMessages: number;
  topQuestions: QuestionStat[];
}

export interface SerializedAnalytics {
  questionCounts: [string, number][];
  callerMessageCount: number;
  callCount: number;
}

export class AnalyticsTracker {
  private questionCounts = new Map<string, number>();
  private callerMessageCount = 0;
  private callCount = 0;

  constructor(initial?: SerializedAnalytics, private onChange?: () => void) {
    if (initial) {
      this.callerMessageCount = initial.callerMessageCount ?? 0;
      this.callCount = initial.callCount ?? 0;
      if (Array.isArray(initial.questionCounts)) {
        this.questionCounts = new Map(initial.questionCounts);
      }
    }
  }

  recordNewCall(): void {
    this.callCount += 1;
    this.onChange?.();
  }

  recordCallerMessage(text: string): void {
    this.callerMessageCount += 1;
    const key = normalizeMessage(text);
    if (!key) return;
    const current = this.questionCounts.get(key) ?? 0;
    this.questionCounts.set(key, current + 1);
    this.onChange?.();
  }

  snapshot(limit = 10): AnalyticsSnapshot {
    const topQuestions: QuestionStat[] = [...this.questionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([text, count]) => ({ text, count }));

    return {
      totalCalls: this.callCount,
      totalCallerMessages: this.callerMessageCount,
      topQuestions,
    };
  }

  serialize(): SerializedAnalytics {
    return {
      questionCounts: [...this.questionCounts.entries()],
      callerMessageCount: this.callerMessageCount,
      callCount: this.callCount,
    };
  }
}
