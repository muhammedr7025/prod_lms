/** Static seed data mirroring the "Exatech Platform" prototype. */

export const INSTITUTION = {
  name: 'Exatech',
  legalName: 'Exatech IT Solutions Pvt Ltd',
  gstin: '32AABCE1234F1Z5',
  address: 'Technopark Phase 1, Kazhakkoottam, Trivandrum 695581',
  phone: '0471 2700 110',
  email: 'hello@exatech.test',
  brandColor: '#4f9d68',
};

export const BRANCHES = [
  {
    code: 'TVM', name: 'Trivandrum', address: 'Technopark Phase 1, Kazhakkoottam', city: 'Trivandrum', phone: '0471 2700 110',
    gstin: '32AABCE1234F1Z5', gstinNote: 'head office', opened: '2019-06-01', status: 'active' as const, statusNote: 'Active', target: 19_30_000,
    rooms: [['Room 1', 30, 'room'], ['Room 2', 20, 'room'], ['Room 3', 24, 'room'], ['Room 4', 20, 'room'], ['Lab 1', 25, 'lab'], ['Lab 2', 24, 'lab'], ['Hall A', 60, 'hall']] as const,
  },
  {
    code: 'EKM', name: 'Kochi', address: 'Kakkanad, Infopark Expressway', city: 'Kochi', phone: '0484 2400 220',
    gstin: null, gstinNote: 'shared with institution', opened: '2022-07-01', status: 'active' as const, statusNote: 'Active', target: 14_70_000,
    rooms: [['EKM Room 1', 30, 'room'], ['EKM Room 2', 24, 'room'], ['EKM Lab 1', 24, 'lab'], ['EKM Lab 2', 20, 'lab'], ['EKM Hall', 60, 'hall']] as const,
  },
  {
    code: 'CLT', name: 'Calicut', address: 'Cyberpark, Palazhi', city: 'Calicut', phone: '0495 2300 330',
    gstin: null, gstinNote: 'shared with institution', opened: '2026-08-01', status: 'active' as const, statusNote: 'Opened Aug 2026', target: 7_20_000,
    rooms: [['CLT Room 1', 25, 'room'], ['CLT Lab 1', 25, 'lab'], ['CLT Room 2', 20, 'room']] as const,
  },
];

export const HOLIDAYS_2026_27: [string, string][] = [
  ['2026-08-15', 'Independence Day'],
  ['2026-08-26', 'Thiruvonam'],
  ['2026-10-02', 'Gandhi Jayanti'],
  ['2026-10-20', 'Vijayadashami'],
  ['2026-11-01', 'Kerala Piravi'],
  ['2026-11-08', 'Deepavali'],
  ['2026-12-25', 'Christmas'],
  ['2027-01-01', 'New Year'],
  ['2027-01-26', 'Republic Day'],
  ['2027-03-10', 'Eid ul-Fitr'],
  ['2027-04-14', 'Vishu'],
  ['2027-04-18', 'Good Friday'],
  ['2027-05-01', 'May Day'],
];

export const COURSES = [
  {
    code: 'DM', name: 'Digital Marketing', category: 'Marketing', months: 4, modality: 'hybrid' as const,
    subjects: ['Search · SEO & analytics', 'Paid media · Google Ads', 'Content strategy', 'Social media'],
    policy: { kind: 'current_instalment' as const },
  },
  {
    code: 'FS', name: 'Full Stack Development', category: 'Engineering', months: 6, modality: 'offline' as const,
    subjects: ['JavaScript foundations', 'React & front-end', 'Node & APIs', 'Databases'],
    policy: { kind: 'current_instalment' as const },
  },
  {
    code: 'DA', name: 'Data Analytics', category: 'Analytics', months: 5, modality: 'hybrid' as const,
    subjects: ['Excel to SQL', 'SQL & data modelling', 'Python for analysis', 'Visualisation'],
    policy: { kind: 'current_instalment' as const },
  },
  {
    code: 'UX', name: 'UI/UX Design', category: 'Design', months: 3, modality: 'online' as const,
    subjects: ['Research', 'Wireframing & prototyping', 'Visual design'],
    policy: { kind: 'fully_paid' as const },
  },
];

/** Pre-tax components (₹) chosen so totals incl. 18% GST are round numbers. */
export const FEE_PLANS: Record<string, { name: string; kind: 'one_time' | 'split' | 'instalments'; components: [string, number][]; schedule: [string, number, number][]; earlyPay?: number; isDefault?: boolean }[]> = {
  DM: [
    { name: 'Split 50 / 50', kind: 'split', isDefault: true, components: [['Tuition', 34000], ['Exam + certification', 4237], ['Material', 2441]], schedule: [['1 · 50% at admission', 50, 0], ['2 · 50% mid-course', 50, 61]] },
    { name: 'One-time', kind: 'one_time', earlyPay: 3, components: [['Tuition', 34000], ['Exam + certification', 4237], ['Material', 2441]], schedule: [['Full fee at admission', 100, 0]] },
    { name: '3 instalments', kind: 'instalments', components: [['Tuition', 34000], ['Exam + certification', 4237], ['Material', 2441]], schedule: [['1 · 40% at admission', 40, 0], ['2 · 30%', 30, 61], ['3 · 30%', 30, 122]] },
  ],
  FS: [
    { name: '3 instalments 40/30/30', kind: 'instalments', isDefault: true, components: [['Tuition', 52542], ['Exam + certification', 4237], ['Material', 4238]], schedule: [['1 · 40% at admission', 40, 0], ['2 · 30%', 30, 61], ['3 · 30%', 30, 122]] },
    { name: 'Split 50 / 50', kind: 'split', components: [['Tuition', 52542], ['Exam + certification', 4237], ['Material', 4238]], schedule: [['1 · 50% at admission', 50, 0], ['2 · 50% mid-course', 50, 90]] },
  ],
  DA: [
    { name: 'Split 50 / 50', kind: 'split', isDefault: true, components: [['Tuition', 42373], ['Exam + certification', 4237], ['Material', 4238]], schedule: [['1 · 50% at admission', 50, 0], ['2 · 50% mid-course', 50, 75]] },
    { name: '3 instalments', kind: 'instalments', components: [['Tuition', 42373], ['Exam + certification', 4237], ['Material', 4238]], schedule: [['1 · 40% at admission', 40, 0], ['2 · 30%', 30, 50], ['3 · 30%', 30, 100]] },
  ],
  UX: [
    { name: 'One-time', kind: 'one_time', isDefault: true, components: [['Tuition', 27119], ['Exam + certification', 2542], ['Material', 847]], schedule: [['Full fee at admission', 100, 0]] },
    { name: 'Split 50 / 50', kind: 'split', components: [['Tuition', 27119], ['Exam + certification', 2542], ['Material', 847]], schedule: [['1 · 50% at admission', 50, 0], ['2 · 50% mid-course', 50, 45]] },
  ],
};

export interface StaffSeed {
  key: string;
  name: string;
  email: string;
  phone: string;
  home: 'TVM' | 'EKM' | 'CLT';
  title: string;
  status?: 'active' | 'leave';
  memberships: { role: string; branches: ('TVM' | 'EKM' | 'CLT')[]; scope: string; isDefault?: boolean }[];
}

export const STAFF: StaffSeed[] = [
  { key: 'deepu', name: 'Deepu S Nath', email: 'deepu@exatech.test', phone: '+919847100001', home: 'TVM', title: 'Founder & Director', memberships: [{ role: 'superadmin', branches: [], scope: 'Institution', isDefault: true }] },
  { key: 'priya', name: 'Priya Varghese', email: 'priya@exatech.test', phone: '+919847100002', home: 'TVM', title: 'Branch Manager, Trivandrum', memberships: [{ role: 'branchadmin', branches: ['TVM'], scope: 'Trivandrum', isDefault: true }, { role: 'teacher', branches: ['TVM'], scope: 'DA-C' }] },
  { key: 'meera', name: 'Meera Pillai', email: 'meera@exatech.test', phone: '+919847100003', home: 'TVM', title: 'Admissions Counsellor', memberships: [{ role: 'sales', branches: ['TVM'], scope: 'TVM · own leads', isDefault: true }] },
  { key: 'arun', name: 'Arun Dev', email: 'arun@exatech.test', phone: '+919847100004', home: 'TVM', title: 'Admissions Counsellor', status: 'leave', memberships: [{ role: 'sales', branches: ['TVM'], scope: 'TVM · own leads', isDefault: true }] },
  { key: 'sanjay', name: 'Sanjay Kumar', email: 'sanjay@exatech.test', phone: '+919847100005', home: 'TVM', title: 'Sales Manager & Trainer', memberships: [{ role: 'salesmanager', branches: ['TVM'], scope: 'Trivandrum', isDefault: true }, { role: 'teacher', branches: ['TVM'], scope: 'FS-B · FS-C' }] },
  { key: 'joseph', name: 'Joseph Mathew', email: 'joseph@exatech.test', phone: '+919847100006', home: 'EKM', title: 'Finance Manager · Kochi branch manager', memberships: [{ role: 'finance', branches: ['TVM', 'EKM'], scope: 'TVM · EKM', isDefault: true }, { role: 'branchadmin', branches: ['EKM'], scope: 'Kochi' }] },
  { key: 'rema', name: 'Rema Nair', email: 'rema@exatech.test', phone: '+919847100007', home: 'TVM', title: 'Cashier', memberships: [{ role: 'finance', branches: ['TVM'], scope: 'TVM', isDefault: true }] },
  { key: 'nithin', name: 'Nithin Raj', email: 'nithin@exatech.test', phone: '+919847100008', home: 'TVM', title: 'Trainer · Digital Marketing', memberships: [{ role: 'teacher', branches: ['TVM'], scope: 'DM-A · DM-B', isDefault: true }] },
  { key: 'anitha', name: 'Anitha Krishnan', email: 'anitha@exatech.test', phone: '+919847100009', home: 'CLT', title: 'Branch Manager, Calicut · Design trainer', memberships: [{ role: 'branchadmin', branches: ['CLT'], scope: 'Calicut' }, { role: 'teacher', branches: ['TVM', 'CLT'], scope: 'UX-A · DA-C1', isDefault: true }] },
  { key: 'rahul', name: 'Rahul Nair', email: 'rahul@exatech.test', phone: '+919847100010', home: 'EKM', title: 'Trainer · Digital Marketing', memberships: [{ role: 'teacher', branches: ['EKM'], scope: 'DM-K1', isDefault: true }] },
  { key: 'anu', name: 'Anu George', email: 'anu@exatech.test', phone: '+919847100011', home: 'EKM', title: 'Trainer · Full Stack', memberships: [{ role: 'teacher', branches: ['EKM'], scope: 'FS-K2', isDefault: true }] },
  { key: 'fathima', name: 'Fathima Rasheed', email: 'fathima@exatech.test', phone: '+919847100012', home: 'EKM', title: 'Admissions Counsellor', memberships: [{ role: 'sales', branches: ['EKM'], scope: 'EKM · own leads', isDefault: true }] },
];

/**
 * Batches. `days` are weekdays (1=Mon … 6=Sat) relative patterns; the seed
 * shifts DM-A / DM-B so the teacher persona always has sessions "today".
 * `startOffset` is days relative to the seed anchor.
 */
export const BATCHES = [
  { code: 'DM-A', branch: 'TVM', course: 'DM', status: 'running', capacity: 30, students: 28, startOffset: -70, room: 'Room 1', teacher: 'nithin', subject: 'Search · SEO & analytics', slots: [['today', '09:00'], ['today+2', '09:00'], ['today+4', '09:00']], plan: 'Split 50 / 50', mode: 'hybrid' },
  { code: 'DM-B', branch: 'TVM', course: 'DM', status: 'running', capacity: 30, students: 11, startOffset: -28, room: 'Room 1', teacher: 'nithin', subject: 'Paid media · Google Ads', slots: [['today', '16:30'], ['today+3', '16:30']], plan: 'Split 50 / 50', mode: 'hybrid' },
  { code: 'FS-B', branch: 'TVM', course: 'FS', status: 'running', capacity: 24, students: 24, startOffset: -71, room: 'Lab 2', teacher: 'sanjay', subject: 'React & front-end', slots: [['mon', '09:00'], ['tue', '09:00'], ['wed', '09:00'], ['thu', '09:00'], ['fri', '09:00']], plan: '3 instalments 40/30/30', mode: 'offline' },
  { code: 'FS-C', branch: 'TVM', course: 'FS', status: 'open', capacity: 24, students: 0, startOffset: 21, room: 'Lab 2', teacher: 'sanjay', subject: 'JavaScript foundations', slots: [['sat', '09:00']], plan: '3 instalments 40/30/30', mode: 'offline' },
  { code: 'DA-C', branch: 'TVM', course: 'DA', status: 'running', capacity: 25, students: 19, startOffset: -45, room: 'Lab 1', teacher: 'priya', subject: 'SQL & data modelling', slots: [['mon', '11:30'], ['wed', '11:30'], ['wed', '14:00']], plan: 'Split 50 / 50', mode: 'hybrid' },
  { code: 'UX-A', branch: 'TVM', course: 'UX', status: 'running', capacity: 20, students: 18, startOffset: -40, room: 'Room 2', teacher: 'anitha', subject: 'Wireframing & prototyping', slots: [['wed', '14:00'], ['sat', '14:00']], plan: 'One-time', mode: 'online' },
  { code: 'DM-K1', branch: 'EKM', course: 'DM', status: 'running', capacity: 30, students: 26, startOffset: -60, room: 'EKM Room 1', teacher: 'rahul', subject: 'Content strategy', slots: [['mon', '09:00'], ['wed', '09:00'], ['fri', '09:00']], plan: 'Split 50 / 50', mode: 'hybrid' },
  { code: 'FS-K2', branch: 'EKM', course: 'FS', status: 'running', capacity: 24, students: 20, startOffset: -50, room: 'EKM Lab 1', teacher: 'anu', subject: 'Node & APIs', slots: [['tue', '11:30'], ['thu', '11:30'], ['sat', '11:30']], plan: '3 instalments 40/30/30', mode: 'offline' },
  { code: 'DM-C', branch: 'EKM', course: 'DM', status: 'waitlist', capacity: 24, students: 0, startOffset: 84, room: 'EKM Room 2', teacher: 'rahul', subject: 'Search · SEO & analytics', slots: [['sat', '14:00']], plan: 'Split 50 / 50', mode: 'offline' },
  { code: 'DA-C1', branch: 'CLT', course: 'DA', status: 'running', capacity: 25, students: 15, startOffset: -35, room: 'CLT Lab 1', teacher: 'anitha', subject: 'Excel to SQL', slots: [['mon', '14:00'], ['thu', '14:00']], plan: 'Split 50 / 50', mode: 'hybrid' },
] as const;

/** Named students from the prototype (first rows of DM-A, plus specific personas). */
export const DMA_NAMES = ['Devika S', 'Hari Kumar', 'Lakshmi Nair', 'Nikhil Raj', 'Parvathy K', 'Sandeep M', 'Anjali Menon', 'Gokul Krishna', 'Vivek Das', 'Zara Khan'];

export const FIRST_NAMES = [
  'Aadhya', 'Abhinav', 'Adithya', 'Akhil', 'Alan', 'Amal', 'Ameya', 'Anagha', 'Anand', 'Ann', 'Anoop', 'Aparna', 'Arathi', 'Ardra', 'Arjun', 'Aswin',
  'Athira', 'Bhavya', 'Christy', 'Deepak', 'Devan', 'Diya', 'Faris', 'Gayathri', 'Gopika', 'Haritha', 'Irfan', 'Jithin', 'Joel', 'Kavya', 'Keerthana',
  'Krishnan', 'Malavika', 'Manu', 'Meenakshi', 'Midhun', 'Nandana', 'Navaneeth', 'Neeraja', 'Nidhin', 'Niranjana', 'Pranav', 'Rahul', 'Reshma',
  'Riya', 'Rohit', 'Sachin', 'Sahla', 'Sanjana', 'Sarath', 'Shilpa', 'Shreya', 'Sidharth', 'Sneha', 'Sreejith', 'Swathi', 'Tessa', 'Varun', 'Vishnu', 'Yadu',
];
export const LAST_NAMES = ['Menon', 'Nair', 'Pillai', 'Kurian', 'Thomas', 'Joseph', 'Varghese', 'Mathew', 'Krishnan', 'Raj', 'Das', 'George', 'Philip', 'Babu', 'Suresh', 'Mohan', 'Rasheed', 'Antony', 'Jose', 'K', 'S', 'R'];

export const LEAD_SOURCES = ['Instagram', 'Website', 'Google Ads', 'Referral', 'Walk-in'] as const;
export const CAMPAIGNS: Record<string, string[]> = {
  Instagram: ['IG_Oct_A', 'IG_Oct_B'],
  Website: ['Organic', 'Course page'],
  'Google Ads': ['GAds_Brand', 'GAds_FS'],
  Referral: ['Alumni referral'],
  'Walk-in': ['Walk-in'],
};

export const TEMPLATES = [
  { channel: 'whatsapp', key: 'intro_v3', name: 'Brochure + batch dates', category: 'sales', status: 'approved', variables: ['name', 'course', 'batch_dates'], body: 'Hi {name}, thanks for your interest in {course} at Exatech. Upcoming batches: {batch_dates}. Brochure attached — reply to book a free counselling call.' },
  { channel: 'whatsapp', key: 'demo_reminder', name: 'Demo reminder', category: 'sales', status: 'approved', variables: ['name', 'date'], body: 'Hi {name}, a reminder of your demo class on {date}. See you at Exatech!' },
  { channel: 'whatsapp', key: 'fee_offer', name: 'Split plan offer', category: 'sales', status: 'pending', variables: ['name', 'course'], body: 'Hi {name}, {course} is available on a 50/50 split plan — pay half now and half mid-course.' },
  { channel: 'whatsapp', key: 'welcome_admission', name: 'Welcome · first invoice', category: 'admission', status: 'approved', variables: ['name', 'admission_no', 'batch', 'amount', 'due'], body: 'Welcome to Exatech, {name}! Admission {admission_no} · {batch}. Your first invoice of {amount} is due {due}. Sign in to the student portal to pay online.' },
  { channel: 'whatsapp', key: 'payment_receipt', name: 'Payment receipt', category: 'payment', status: 'approved', variables: ['name', 'amount', 'receipt_no', 'balance'], body: 'Payment received: {amount} for {name}. Receipt {receipt_no}. Balance {balance}. Thank you — Exatech.' },
  { channel: 'whatsapp', key: 'fee_reminder', name: 'Fee reminder', category: 'fee_due', status: 'approved', variables: ['name', 'amount', 'due', 'link'], body: 'Reminder: {amount} for {name} is due {due}. Pay online: {link}' },
  { channel: 'whatsapp', key: 'absence_alert', name: 'Absence alert', category: 'attendance', status: 'approved', variables: ['name', 'batch', 'date'], body: '{name} was marked absent in {batch} today ({date}). Please contact the class teacher if this is unexpected.' },
  { channel: 'whatsapp', key: 'marks_published', name: 'Marks published', category: 'marks', status: 'approved', variables: ['name', 'exam', 'score'], body: 'Marks published for {name}: {exam} — {score}. View details in the portal.' },
  { channel: 'whatsapp', key: 'otp', name: 'Sign-in code', category: 'auth', status: 'approved', variables: ['code'], body: 'Your Exatech sign-in code is {code}. It expires in 5 minutes. Do not share it.' },
  { channel: 'whatsapp', key: 'announcement', name: 'Announcement', category: 'announcement', status: 'approved', variables: ['title', 'body'], body: '{title}\n\n{body}' },
] as const;
