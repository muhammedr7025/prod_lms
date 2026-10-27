import { describe, expect, it } from 'vitest';
import {
  addMonths,
  allocatePayment,
  applyLatePenalty,
  assignLead,
  attendancePercent,
  buildSchedule,
  canAccessMaterial,
  canSubmitMarks,
  computeClearance,
  computeLateFee,
  discountApprovalLevel,
  evaluateMarkRow,
  examStats,
  financialYear,
  findWeekConflicts,
  formatINR,
  formatINRCompact,
  formatNumber,
  gradeFor,
  istDateTime,
  maskPhone,
  mondayOf,
  nextAttendanceStatus,
  nextStage,
  normalizePhone,
  quoteFee,
  rupees,
  splitByPercent,
  toISTDate,
  toISTTime,
  transferAdjustment,
  validateDeskPayment,
  validatePattern,
  validateSession,
  ageingBucket,
  type SlotSession,
} from '../src';

describe('money', () => {
  it('formats Indian grouping', () => {
    expect(formatINR(rupees(214500))).toBe('₹2,14,500');
    expect(formatINR(rupees(15000))).toBe('₹15,000');
    expect(formatINR(-rupees(5760))).toBe('−₹5,760');
  });
  it('formats compact lakh/crore', () => {
    expect(formatINRCompact(rupees(4860000))).toBe('₹48.6L');
    expect(formatINRCompact(rupees(500000))).toBe('₹5L');
    expect(formatINRCompact(rupees(68000))).toBe('₹68,000');
    expect(formatINRCompact(rupees(24000000))).toBe('₹2.4Cr');
  });
  it('splits by percent and sums exactly', () => {
    const parts = splitByPercent(rupees(72000), [40, 30, 30]);
    expect(parts).toEqual([rupees(28800), rupees(21600), rupees(21600)]);
    const odd = splitByPercent(rupees(49843), [50, 50]);
    expect(odd[0]! + odd[1]!).toBe(rupees(49843));
  });
});

describe('fee quote & schedule', () => {
  it('matches the admission wizard preview (12% discount, 18% GST)', () => {
    const q = quoteFee(
      [
        { name: 'Tuition', amount: rupees(40000) },
        { name: 'Exam + certification', amount: rupees(5000) },
        { name: 'Material', amount: rupees(3000) },
      ],
      12,
      18,
    );
    expect(q.subtotal).toBe(rupees(48000));
    expect(q.discount).toBe(rupees(5760));
    expect(q.gst).toBe(rupees(7603));
    expect(q.total).toBe(rupees(49843));
  });
  it('builds schedules that sum to total', () => {
    const rows = buildSchedule(rupees(72000), [
      { label: '1 · 40% at admission', pct: 40, dueOffsetDays: 0 },
      { label: '2 · 30%', pct: 30, dueOffsetDays: 61 },
      { label: '3 · 30%', pct: 30, dueOffsetDays: 122 },
    ], '2026-08-01');
    expect(rows.map((r) => r.amount)).toEqual([rupees(28800), rupees(21600), rupees(21600)]);
    expect(rows[1]!.dueDate).toBe('2026-10-01');
  });
  it('rejects schedules not summing to 100', () => {
    expect(() => buildSchedule(100, [{ label: 'a', pct: 60, dueOffsetDays: 0 }], '2026-01-01')).toThrow();
  });
  it('picks the discount approval level', () => {
    expect(discountApprovalLevel(8)).toBe('none');
    expect(discountApprovalLevel(10)).toBe('none');
    expect(discountApprovalLevel(12)).toBe('finance');
    expect(discountApprovalLevel(22)).toBe('super_admin');
  });
});

describe('fee clearance', () => {
  const insts = [
    { dueDate: '2026-08-01', amount: rupees(28800), paid: rupees(28800) },
    { dueDate: '2026-10-01', amount: rupees(21600), paid: rupees(6600) },
    { dueDate: '2026-12-01', amount: rupees(21600), paid: 0 },
  ];
  it('current instalment policy locks when a due instalment is unpaid', () => {
    const r = computeClearance({ instalments: insts, policy: { kind: 'current_instalment' }, today: '2026-10-11' });
    expect(r.cleared).toBe(false);
  });
  it('unlocks once the overdue instalment is paid, cleared until next due − 1', () => {
    const paid = insts.map((i, k) => (k === 1 ? { ...i, paid: i.amount } : i));
    const r = computeClearance({ instalments: paid, policy: { kind: 'current_instalment' }, today: '2026-10-11' });
    expect(r.cleared).toBe(true);
    expect(r.clearedUntil).toBe('2026-11-30');
  });
  it('fully paid and percentage policies', () => {
    expect(computeClearance({ instalments: insts, policy: { kind: 'fully_paid' }, today: '2026-10-11' }).cleared).toBe(false);
    expect(computeClearance({ instalments: insts, policy: { kind: 'percentage', percentage: 45 }, today: '2026-10-11' }).cleared).toBe(true);
    expect(computeClearance({ instalments: insts, policy: { kind: 'percentage', percentage: 60 }, today: '2026-10-11' }).cleared).toBe(false);
  });
  it('honours temporary exemption', () => {
    const r = computeClearance({ instalments: insts, policy: { kind: 'current_instalment' }, today: '2026-10-11', exemptUntil: '2026-10-31' });
    expect(r).toMatchObject({ cleared: true, exempt: true, clearedUntil: '2026-10-31' });
    const expired = computeClearance({ instalments: insts, policy: { kind: 'current_instalment' }, today: '2026-11-01', exemptUntil: '2026-10-31' });
    expect(expired.cleared).toBe(false);
  });
  it('gates material access', () => {
    const now = new Date('2026-10-11T06:00:00Z');
    expect(canAccessMaterial({ visibility: 'always', releaseAt: null }, { feeCleared: false }, now)).toBe(true);
    expect(canAccessMaterial({ visibility: 'fee_gated', releaseAt: null }, { feeCleared: false }, now)).toBe(false);
    expect(canAccessMaterial({ visibility: 'fee_gated', releaseAt: null }, { feeCleared: true }, now)).toBe(true);
    expect(canAccessMaterial({ visibility: 'scheduled', releaseAt: new Date('2026-10-24T00:00:00Z') }, { feeCleared: true }, now)).toBe(false);
    expect(canAccessMaterial({ visibility: 'scheduled', releaseAt: new Date('2026-10-01T00:00:00Z') }, { feeCleared: true }, now)).toBe(true);
  });
});

describe('payments', () => {
  it('allocates oldest due first and holds excess as credit', () => {
    const r = allocatePayment(rupees(20000), [
      { id: 'i3', dueDate: '2026-12-01', balance: rupees(21600) },
      { id: 'i2', dueDate: '2026-10-01', balance: rupees(15000) },
    ]);
    expect(r.allocations).toEqual([
      { id: 'i2', amount: rupees(15000) },
      { id: 'i3', amount: rupees(5000) },
    ]);
    expect(r.excess).toBe(0);
    expect(allocatePayment(rupees(40000), [{ id: 'a', dueDate: '2026-10-01', balance: rupees(15000) }]).excess).toBe(rupees(25000));
  });
  it('computes capped late fee after grace on unpaid balance only', () => {
    const inst = { dueDate: '2026-10-01', amount: rupees(21600), balance: rupees(15000) };
    expect(computeLateFee(inst, '2026-10-03')).toBe(0);
    expect(computeLateFee(inst, '2026-10-06')).toBe(rupees(200));
    expect(computeLateFee(inst, '2026-12-31')).toBe(rupees(1080)); // 5% cap
    expect(computeLateFee({ ...inst, balance: 0 }, '2026-12-31')).toBe(0);
  });
  it('flat late fee: ₹1,000 once 90 days overdue (capAmount)', () => {
    const rule = { graceDays: 90, perDay: rupees(1000), capPct: 100, capAmount: rupees(1000) };
    const inst = { dueDate: '2026-10-01', amount: rupees(55000), balance: rupees(55000) };
    expect(computeLateFee(inst, '2026-12-30', rule)).toBe(0);
    expect(computeLateFee(inst, '2026-12-31', rule)).toBe(rupees(1000));
    expect(computeLateFee(inst, '2027-06-01', rule)).toBe(rupees(1000));
  });
  it('validates desk tenders', () => {
    expect(validateDeskPayment([{ method: 'cash', amount: rupees(500) }], rupees(15000)).ok).toBe(false);
    expect(validateDeskPayment([{ method: 'cash', amount: rupees(500) }], rupees(500)).ok).toBe(true);
    expect(validateDeskPayment([{ method: 'upi', amount: rupees(15000) }], rupees(15000)).ok).toBe(false);
    expect(validateDeskPayment([{ method: 'upi', amount: rupees(15000), reference: 'UTR123' }], rupees(15000)).ok).toBe(true);
  });
  it('ages dues', () => {
    expect(ageingBucket('2026-10-01', '2026-10-11')).toBe('0-30');
    expect(ageingBucket('2026-07-01', '2026-10-11')).toBe('90+');
  });
  it('pro-rates transfer adjustments', () => {
    expect(transferAdjustment(rupees(48000), rupees(54000), 25)).toBe(rupees(4500));
  });
});

describe('dates', () => {
  it('computes FY and IST conversions', () => {
    expect(financialYear('2026-10-11')).toBe('2026-27');
    expect(financialYear('2027-03-31')).toBe('2026-27');
    expect(financialYear('2027-04-01')).toBe('2027-28');
    expect(toISTDate(new Date('2026-10-10T20:00:00Z'))).toBe('2026-10-11');
    expect(toISTTime(istDateTime('2026-10-11', '09:00'))).toBe('09:00');
    expect(mondayOf('2026-10-11')).toBe('2026-10-05');
    expect(mondayOf('2026-10-13')).toBe('2026-10-12');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
});

describe('phone', () => {
  it('normalises and masks', () => {
    expect(normalizePhone('9847011223')).toBe('+919847011223');
    expect(normalizePhone('+91 98470-11223')).toBe('+919847011223');
    expect(normalizePhone('09847011223')).toBe('+919847011223');
    expect(normalizePhone('9847')).toBeNull();
    expect(maskPhone('+919847011210')).toBe('98•••••210');
  });
});

describe('numbering', () => {
  it('formats gap-free patterns', () => {
    expect(formatNumber('{BRANCH}/RCPT/{FY}/{SEQ:6}', { BRANCH: 'TVM', FY: '2026-27', SEQ: 184 })).toBe('TVM/RCPT/2026-27/000184');
    expect(formatNumber('{BRANCH}-{COURSE}-{YEAR}-{SEQ:5}', { BRANCH: 'TVM', COURSE: 'DM', YEAR: 2027, SEQ: 142 })).toBe('TVM-DM-2027-00142');
    expect(validatePattern('{BRANCH}/X').ok).toBe(false);
    expect(validatePattern('{BRANCH}/{FOO}/{SEQ}').ok).toBe(false);
  });
});

describe('timetable', () => {
  const base: SlotSession = {
    id: 's1', branchId: 'tvm', batchId: 'dma', batchCode: 'DM-A', teacherId: 'nithin', teacherName: 'Nithin Raj',
    roomId: 'r1', roomName: 'Room 1', date: '2026-10-13', start: '09:00', end: '11:00',
  };
  it('blocks room and teacher clashes, leave and holidays', () => {
    const existing: SlotSession[] = [{ ...base, id: 'x', batchId: 'fsb', batchCode: 'FS-B', teacherId: 'sanjay', teacherName: 'Sanjay' }];
    const issues = validateSession({ ...base, id: 'new' }, { existing, holidays: [], approvedLeave: [] });
    expect(issues.map((i) => i.code)).toEqual(['ROOM_CLASH']);
    const t = validateSession({ ...base, id: 'new', roomId: 'r2', teacherId: 'sanjay', teacherName: 'Sanjay' }, { existing, holidays: [], approvedLeave: [] });
    expect(t.map((i) => i.code)).toEqual(['TEACHER_CLASH']);
    const leave = validateSession(base, { existing: [], holidays: [{ date: '2026-10-13', name: 'Test', branchId: null }], approvedLeave: [{ teacherId: 'nithin', date: '2026-10-13' }] });
    expect(leave.map((i) => i.code).sort()).toEqual(['HOLIDAY', 'TEACHER_ON_LEAVE']);
  });
  it('enforces the cross-branch travel buffer', () => {
    const existing: SlotSession[] = [{ ...base, id: 'k', branchId: 'ekm', roomId: 'k1', start: '11:30', end: '13:30' }];
    expect(validateSession(base, { existing, holidays: [], approvedLeave: [] }).map((i) => i.code)).toEqual(['TEACHER_TRAVEL']);
    expect(validateSession(base, { existing, holidays: [], approvedLeave: [], travelBufferMin: 15 })).toEqual([]);
  });
  it('suggests a free room for week conflicts', () => {
    const sessions: SlotSession[] = [base, { ...base, id: 's2', batchId: 'uxa', batchCode: 'UX-A', teacherId: 'anitha', teacherName: 'Anitha' }];
    const c = findWeekConflicts(sessions, { rooms: [{ id: 'r1', name: 'Room 1', capacity: 30, branchId: 'tvm' }, { id: 'r4', name: 'Room 4', capacity: 20, branchId: 'tvm' }] });
    expect(c).toHaveLength(1);
    expect(c[0]!.fix?.label).toBe('Move UX-A to Room 4');
  });
});

describe('academics', () => {
  const comps = [{ name: 'Theory', max: 60 }, { name: 'Practical', max: 40 }];
  it('evaluates mark rows', () => {
    expect(evaluateMarkRow([52, 36], comps)).toMatchObject({ total: 88, complete: true, invalid: false });
    expect(evaluateMarkRow([65, 36], comps).invalid).toBe(true);
    expect(evaluateMarkRow([52, null], comps).complete).toBe(false);
  });
  it('only allows submission when every row is complete and valid', () => {
    expect(canSubmitMarks([[52, 36], [null, 30]], comps).ok).toBe(false);
    expect(canSubmitMarks([[52, 36], [61, 30]], comps).ok).toBe(false);
    expect(canSubmitMarks([[52, 36], [44, 30]], comps).ok).toBe(true);
  });
  it('computes exam stats', () => {
    expect(examStats([[50, 34], [44, 30], [null, null]], comps)).toMatchObject({ average: 79, highest: 84, lowest: 74, missing: 1 });
  });
  it('grades and attendance', () => {
    expect(gradeFor(84)).toBe('A');
    expect(gradeFor(39)).toBe('F');
    expect(attendancePercent(['P', 'P', 'A', 'L', 'E'])).toBe(75);
    expect(nextAttendanceStatus('P')).toBe('A');
    expect(nextAttendanceStatus('E')).toBe('P');
  });
  it('applies late penalties', () => {
    expect(applyLatePenalty(40, 50, 'minus_10_per_day', 2)).toBe(30);
    expect(applyLatePenalty(4, 50, 'minus_10_per_day', 2)).toBe(0);
  });
});

describe('sales', () => {
  it('advances stages by click only up to negotiation', () => {
    expect(nextStage('new')).toBe('contacted');
    expect(nextStage('negotiation')).toBeNull();
  });
  it('assigns by top-down rules with round robin', () => {
    const rules = [
      { id: 'r1', position: 1, enabled: true, condition: { sources: ['Referral'] }, assigneeIds: ['meera'], cursor: 0 },
      { id: 'r2', position: 2, enabled: true, condition: { courseIds: ['fs', 'da'] }, assigneeIds: ['sanjay', 'arun'], cursor: 1 },
      { id: 'r4', position: 4, enabled: true, condition: {}, assigneeIds: ['meera', 'arun'], cursor: 0 },
    ];
    expect(assignLead({ source: 'Referral', courseId: 'fs', preferredBranchId: null }, rules)).toMatchObject({ ruleId: 'r1', assigneeId: 'meera' });
    expect(assignLead({ source: 'Website', courseId: 'fs', preferredBranchId: null }, rules)).toMatchObject({ ruleId: 'r2', assigneeId: 'arun', nextCursor: 0 });
    expect(assignLead({ source: 'Website', courseId: 'fs', preferredBranchId: null }, rules, (u) => u !== 'arun')).toMatchObject({ assigneeId: 'sanjay' });
    expect(assignLead({ source: 'Website', courseId: 'dm', preferredBranchId: null }, rules)).toMatchObject({ ruleId: 'r4' });
  });
});
