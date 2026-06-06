// 共享英文姓名库与随机生成逻辑
// 用于注册时生成更自然、低重复率的「全名」与「邮箱前缀」。
// 名字主体覆盖大量常见英文名/姓，邮箱前缀模拟真实用户的命名习惯，避免一眼机器生成。

export const FIRST_NAMES: readonly string[] = [
  // 男性常见名
  'James', 'Robert', 'John', 'Michael', 'David', 'William', 'Richard', 'Joseph', 'Thomas', 'Charles',
  'Christopher', 'Daniel', 'Matthew', 'Anthony', 'Mark', 'Donald', 'Steven', 'Paul', 'Andrew', 'Joshua',
  'Kenneth', 'Kevin', 'Brian', 'George', 'Timothy', 'Ronald', 'Edward', 'Jason', 'Jeffrey', 'Ryan',
  'Jacob', 'Gary', 'Nicholas', 'Eric', 'Jonathan', 'Stephen', 'Larry', 'Justin', 'Scott', 'Brandon',
  'Benjamin', 'Samuel', 'Raymond', 'Gregory', 'Frank', 'Alexander', 'Patrick', 'Jack', 'Dennis', 'Jerry',
  'Tyler', 'Aaron', 'Jose', 'Adam', 'Nathan', 'Henry', 'Zachary', 'Douglas', 'Peter', 'Kyle',
  'Noah', 'Ethan', 'Jeremy', 'Walter', 'Christian', 'Keith', 'Roger', 'Terry', 'Austin', 'Sean',
  'Gerald', 'Carl', 'Harold', 'Dylan', 'Arthur', 'Lawrence', 'Jordan', 'Jesse', 'Bryan', 'Billy',
  'Bruce', 'Gabriel', 'Joe', 'Logan', 'Alan', 'Juan', 'Albert', 'Elijah', 'Wayne', 'Randy',
  'Vincent', 'Mason', 'Roy', 'Ralph', 'Russell', 'Bradley', 'Philip', 'Eugene', 'Louis', 'Caleb',
  'Hunter', 'Connor', 'Aidan', 'Ian', 'Cameron', 'Owen', 'Luke', 'Isaac', 'Wesley', 'Carlos',
  'Miguel', 'Antonio', 'Victor', 'Marcus', 'Travis', 'Cole', 'Blake', 'Shawn', 'Trevor', 'Spencer',
  'Devin', 'Colin', 'Drew', 'Grant', 'Theodore', 'Oliver', 'Liam', 'Lucas', 'Nathaniel', 'Adrian',
  'Dean', 'Derek', 'Evan', 'Fred', 'Harry', 'Hayden', 'Leo', 'Brad',
  // 女性常见名
  'Mary', 'Patricia', 'Jennifer', 'Linda', 'Barbara', 'Elizabeth', 'Susan', 'Jessica', 'Sarah', 'Karen',
  'Lisa', 'Nancy', 'Betty', 'Margaret', 'Sandra', 'Ashley', 'Dorothy', 'Kimberly', 'Emily', 'Donna',
  'Michelle', 'Carol', 'Amanda', 'Melissa', 'Deborah', 'Stephanie', 'Rebecca', 'Sharon', 'Laura', 'Cynthia',
  'Kathleen', 'Amy', 'Angela', 'Shirley', 'Anna', 'Brenda', 'Pamela', 'Emma', 'Nicole', 'Helen',
  'Samantha', 'Katherine', 'Christine', 'Debra', 'Rachel', 'Carolyn', 'Janet', 'Catherine', 'Maria', 'Heather',
  'Diane', 'Olivia', 'Julie', 'Joyce', 'Victoria', 'Kelly', 'Christina', 'Joan', 'Evelyn', 'Lauren',
  'Judith', 'Megan', 'Cheryl', 'Andrea', 'Hannah', 'Martha', 'Jacqueline', 'Frances', 'Gloria', 'Ann',
  'Teresa', 'Kathryn', 'Sophia', 'Madison', 'Abigail', 'Grace', 'Natalie', 'Brittany', 'Danielle', 'Sara',
  'Alexis', 'Isabella', 'Mia', 'Charlotte', 'Amelia', 'Ava', 'Chloe', 'Ella', 'Avery', 'Sofia',
  'Aria', 'Scarlett', 'Allison', 'Audrey', 'Brooke', 'Claire', 'Lily', 'Zoe', 'Leah', 'Hailey',
  'Paige', 'Vanessa', 'Alice', 'Amber', 'Aubrey', 'Beverly', 'Dawn', 'Diana', 'Holly', 'Julia',
  'Kayla', 'Lucy', 'Lydia', 'Molly', 'Nora', 'Riley', 'Tammy', 'Tina', 'Valerie', 'Wendy'
]

export const LAST_NAMES: readonly string[] = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
  'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
  'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson',
  'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
  'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera', 'Campbell', 'Mitchell', 'Carter', 'Roberts',
  'Gomez', 'Phillips', 'Evans', 'Turner', 'Diaz', 'Parker', 'Cruz', 'Edwards', 'Collins', 'Reyes',
  'Stewart', 'Morris', 'Morales', 'Murphy', 'Cook', 'Rogers', 'Gutierrez', 'Ortiz', 'Morgan', 'Cooper',
  'Peterson', 'Bailey', 'Reed', 'Kelly', 'Howard', 'Ramos', 'Kim', 'Cox', 'Ward', 'Richardson',
  'Watson', 'Brooks', 'Chavez', 'Wood', 'James', 'Bennett', 'Gray', 'Mendoza', 'Ruiz', 'Hughes',
  'Price', 'Alvarez', 'Castillo', 'Sanders', 'Patel', 'Myers', 'Long', 'Ross', 'Foster', 'Jimenez',
  'Powell', 'Jenkins', 'Perry', 'Russell', 'Sullivan', 'Bell', 'Coleman', 'Butler', 'Henderson', 'Barnes',
  'Gonzales', 'Fisher', 'Vasquez', 'Simmons', 'Romero', 'Jordan', 'Patterson', 'Alexander', 'Hamilton', 'Graham',
  'Reynolds', 'Griffin', 'Wallace', 'Moreno', 'West', 'Cole', 'Hayes', 'Bryant', 'Herrera', 'Gibson',
  'Ellis', 'Tran', 'Medina', 'Aguilar', 'Stevens', 'Murray', 'Ford', 'Castro', 'Marshall', 'Owens',
  'Harrison', 'Fernandez', 'Mcdonald', 'Woods', 'Washington', 'Kennedy', 'Wells', 'Vargas', 'Henry', 'Chen',
  'Freeman', 'Webb', 'Tucker', 'Guzman', 'Burns', 'Crawford', 'Olson', 'Simpson', 'Porter', 'Hunter',
  'Gordon', 'Mendez', 'Silva', 'Shaw', 'Snyder', 'Mason', 'Dixon', 'Munoz', 'Hunt', 'Hicks',
  'Holmes', 'Palmer', 'Wagner', 'Black', 'Robertson', 'Boyd', 'Rose', 'Stone', 'Salazar', 'Fox',
  'Warren', 'Mills', 'Meyer', 'Rice', 'Schmidt', 'Garza', 'Daniels', 'Ferguson', 'Nichols', 'Stephens',
  'Soto', 'Weaver', 'Ryan', 'Gardner', 'Payne', 'Grant', 'Dunn', 'Kelley', 'Spencer', 'Hawkins',
  'Arnold', 'Pierce', 'Vazquez', 'Hansen', 'Peters', 'Santos', 'Hart'
]

// 常见英文昵称（小写），仅用于邮箱前缀，模拟真人随意取名
export const NICKNAMES: readonly string[] = [
  'mike', 'dave', 'chris', 'alex', 'sam', 'jess', 'kate', 'tom', 'nick', 'joe',
  'dan', 'matt', 'rob', 'will', 'ben', 'jen', 'liz', 'beth', 'andy', 'tony',
  'jim', 'bob', 'rick', 'steve', 'greg', 'ken', 'charlie', 'jack', 'jake', 'max',
  'gabe', 'nate', 'zach', 'josh', 'tim', 'pat', 'vince', 'leo', 'ray', 'gene',
  'marty', 'phil', 'pete', 'randy', 'russ', 'abby', 'allie', 'becky', 'bella', 'cassie',
  'cathy', 'debbie', 'ellie', 'gabby', 'gracie', 'izzy', 'josie', 'katie', 'lucy', 'maggie',
  'mandy', 'meg', 'mel', 'millie', 'nina', 'patty', 'penny', 'rosie', 'sadie', 'sally',
  'sandy', 'sue', 'tess', 'val', 'vicky', 'wendy'
]

function randInt(max: number): number {
  return Math.floor(Math.random() * max)
}

function pick<T>(arr: readonly T[]): T {
  return arr[randInt(arr.length)]
}

// 少量随机小写字母后缀（1-2 个），仅在基础名字组合时用于补足唯一性
function randomLetters(): string {
  const n = 1 + randInt(2)
  let s = ''
  for (let i = 0; i < n; i++) s += String.fromCharCode(97 + randInt(26))
  return s
}

// 随机全名（用于注册显示名），偶尔带中间名首字母，进一步降低重复率
export function randomFullName(): string {
  const first = pick(FIRST_NAMES)
  const last = pick(LAST_NAMES)
  if (Math.random() < 0.18) {
    const mid = String.fromCharCode(65 + randInt(26)) // A-Z
    return `${first} ${mid}. ${last}`
  }
  return `${first} ${last}`
}

// 随机邮箱前缀：以真实名字成分组合为主（中间名、双姓等，无数字无乱码、最像真人），
// 少量基础组合补 1-2 个随机字母保证唯一，整体低重复且自然
export function randomEmailPrefix(): string {
  const first = pick(FIRST_NAMES).toLowerCase()
  const last = pick(LAST_NAMES).toLowerCase()
  const middle = pick(FIRST_NAMES).toLowerCase()
  const last2 = pick(LAST_NAMES).toLowerCase()
  const nick = pick(NICKNAMES)
  const fi = first.charAt(0)
  const mi = middle.charAt(0)
  const li = last.charAt(0)

  const r = Math.random()

  // 约 72%：真实名字多成分组合，高度唯一且最自然
  if (r < 0.72) {
    const s = pick(['.', '.', '.', '_'])
    return pick([
      `${first}${s}${middle}${s}${last}`, // john.michael.smith
      `${first}${s}${mi}${s}${last}`,     // john.m.smith
      `${first}${mi}${s}${last}`,         // johnm.smith
      `${first}${s}${last}${s}${last2}`,  // john.smith.brown（双姓）
      `${fi}${s}${middle}${s}${last}`,    // j.michael.smith
      `${first}${s}${middle}`,            // john.michael
      `${middle}${s}${last}`,             // michael.smith
      `${nick}${s}${middle}${s}${last}`   // mike.john.smith
    ])
  }

  // 约 18%：基础名字组合 + 1-2 个随机字母，兼顾自然与唯一
  if (r < 0.9) {
    const base = pick([
      `${first}${last}`,
      `${first}.${last}`,
      `${fi}${last}`,
      `${first}${li}`,
      `${nick}${last}`,
      `${last}${fi}`
    ])
    return `${base}${randomLetters()}`
  }

  // 约 10%：纯净名字组合（无任何后缀），保留少量最简洁写法
  return pick([
    `${first}.${last}`,
    `${first}${last}`,
    `${nick}.${last}`,
    `${first}.${middle}.${last}`
  ])
}
