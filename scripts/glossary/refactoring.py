from common import write

def slug(title):
    return title.lower().replace("/", "-").replace(" ", "-")

# ─────────────── Code smells (names/groups verified against refactoring.guru/refactoring/smells) ───────────────
SMELLS = {
    "Bloaters": [
        ("Long Method", "A method has grown so long it's hard to understand, test or reuse.",
         ["You scroll to read it", "Comments separate 'sections' inside it", "Many local variables"],
         ["extract-method", "replace-temp-with-query", "introduce-parameter-object", "decompose-conditional"]),
        ("Large Class", "A class tries to do too much: too many fields, methods and responsibilities.",
         ["Many unrelated fields", "Methods cluster into separate groups", "Frequent merge conflicts in one file"],
         ["extract-class", "extract-subclass", "extract-interface"]),
        ("Primitive Obsession", "Domain concepts (money, email, phone, status) are passed around as raw strings and numbers.",
         ["Validation of the same value repeated everywhere", "Constants used as type codes", "Arrays used as records"],
         ["replace-data-value-with-object", "replace-type-code-with-class", "replace-array-with-object", "introduce-parameter-object"]),
        ("Long Parameter List", "A method takes so many parameters that calls are hard to read and easy to get wrong.",
         ["More than 3–4 parameters", "Boolean flag arguments", "The same group of args appears in many calls"],
         ["introduce-parameter-object", "preserve-whole-object", "replace-parameter-with-method-call"]),
        ("Data Clumps", "The same group of values always travels together (start/end dates, lat/lng, street/city/zip).",
         ["Identical parameter groups across methods", "Fields that are only meaningful together"],
         ["extract-class", "introduce-parameter-object", "preserve-whole-object"]),
    ],
    "Object-Orientation Abusers": [
        ("Alternative Classes with Different Interfaces", "Two classes do the same job but expose different method names.",
         ["Callers need adapters or conditionals to use either"], ["rename-method", "move-method", "extract-superclass"]),
        ("Refused Bequest", "A subclass inherits methods or data it doesn't want, overriding them to do nothing or throw.",
         ["Overrides that throw 'not supported'", "Inheritance used only to reuse code"],
         ["replace-inheritance-with-delegation", "extract-superclass", "push-down-method"]),
        ("Switch Statements", "The same `switch`/`match`/if-chain on a type code appears in several places.",
         ["Adding a type means editing many switches"],
         ["replace-conditional-with-polymorphism", "replace-type-code-with-subclasses", "replace-type-code-with-state-strategy"]),
        ("Temporary Field", "A field is only set and used in certain situations and is empty the rest of the time.",
         ["Nullable fields used by one algorithm", "Checks for 'is this set yet?'"], ["extract-class", "introduce-null-object"]),
    ],
    "Change Preventers": [
        ("Divergent Change", "One class has to be edited for many unrelated reasons.",
         ["'To add a payment method I edit this class... and also to change reporting'"], ["extract-class"]),
        ("Parallel Inheritance Hierarchies", "Every time you add a subclass in one hierarchy, you must add one in another.",
         ["Matching class-name prefixes across two trees"], ["move-method", "move-field"]),
        ("Shotgun Surgery", "One logical change requires many small edits across many classes.",
         ["A small feature touches 10 files"], ["move-method", "move-field", "inline-class"]),
    ],
    "Dispensables": [
        ("Comments", "Comments explain what confusing code does, instead of the code explaining itself.",
         ["Comments describing *what*, not *why*"], ["extract-variable", "extract-method", "rename-method", "introduce-assertion"]),
        ("Duplicate Code", "The same or very similar code exists in more than one place.",
         ["Copy-pasted blocks with small tweaks"], ["extract-method", "pull-up-method", "form-template-method", "substitute-algorithm"]),
        ("Data Class", "A class only holds fields with getters/setters, while the behaviour using that data lives elsewhere.",
         ["Logic about the data is in services that 'envy' it"], ["encapsulate-field", "encapsulate-collection", "move-method"]),
        ("Dead Code", "Variables, parameters, methods or classes that are never used.",
         ["Unreachable branches", "Unused imports/params"], ["inline-class", "remove-parameter"]),
        ("Lazy Class", "A class does so little that it isn't worth the cost of understanding it.",
         ["A class that only delegates or wraps one call"], ["inline-class", "collapse-hierarchy"]),
        ("Speculative Generality", "Unused abstractions, hooks and parameters added 'just in case'.",
         ["Abstract classes with one subclass", "Unused parameters"], ["collapse-hierarchy", "inline-class", "inline-method", "remove-parameter"]),
    ],
    "Couplers": [
        ("Feature Envy", "A method uses another object's data more than its own.",
         ["Long chains of getters on another object"], ["move-method", "extract-method"]),
        ("Inappropriate Intimacy", "Two classes know too much about each other's internals.",
         ["Accessing each other's private-ish fields", "Bidirectional associations everywhere"],
         ["move-method", "move-field", "change-bidirectional-association-to-unidirectional", "hide-delegate"]),
        ("Incomplete Library Class", "A library lacks a method you need, and you can't modify it.",
         ["Utility helpers wrapping library objects scattered around"], ["introduce-foreign-method", "introduce-local-extension"]),
        ("Message Chains", "Code navigates long chains like `$a->b()->c()->d()`.",
         ["Callers depend on the structure of a whole object graph"], ["hide-delegate", "extract-method", "move-method"]),
        ("Middle Man", "A class delegates almost everything to another class and adds nothing.",
         ["Most methods are one-line pass-throughs"], ["remove-middle-man", "inline-method"]),
    ],
}

# ─────────────── Refactoring techniques (names/groups verified against refactoring.guru/refactoring/catalog) ───────────────
TECHNIQUES = {
    "Composing Methods": [
        ("Extract Method", "Move a fragment of code into its own well-named method."),
        ("Inline Method", "Replace calls to a trivial method with its body, then delete it."),
        ("Extract Variable", "Put a complex expression's result in a variable whose name explains it."),
        ("Inline Temp", "Replace a temporary variable that holds a simple expression with the expression itself."),
        ("Replace Temp with Query", "Move an expression stored in a temp into a method and call it instead."),
        ("Split Temporary Variable", "Use separate variables when one temp is reused for different values."),
        ("Remove Assignments to Parameters", "Assign to a local variable instead of reassigning a parameter."),
        ("Replace Method with Method Object", "Turn a long method with tangled locals into its own class so you can split it."),
        ("Substitute Algorithm", "Replace an algorithm with a clearer or simpler one that gives the same result."),
    ],
    "Moving Features between Objects": [
        ("Move Method", "Move a method to the class that uses it most."),
        ("Move Field", "Move a field to the class that uses it most."),
        ("Extract Class", "Split part of a class's responsibilities into a new class."),
        ("Inline Class", "Fold a class that does too little into another class."),
        ("Hide Delegate", "Add a method on the server that hides the delegate, so clients don't chain through it."),
        ("Remove Middle Man", "Let clients call the delegate directly when a class only forwards calls."),
        ("Introduce Foreign Method", "Add a helper in the client (taking the library object as an argument) for a missing library method."),
        ("Introduce Local Extension", "Create a subclass or wrapper of a library class that adds the methods you need."),
    ],
    "Organizing Data": [
        ("Change Value to Reference", "Replace many identical value copies with a single shared reference object."),
        ("Change Reference to Value", "Turn a small, rarely-changed reference object into an immutable value object."),
        ("Duplicate Observed Data", "Separate domain data from UI classes and keep them in sync via observers."),
        ("Self Encapsulate Field", "Access a field through getters/setters even inside its own class."),
        ("Replace Data Value with Object", "Turn a primitive field with behaviour into its own object."),
        ("Replace Array with Object", "Replace an array holding different kinds of data with an object with named fields."),
        ("Change Unidirectional Association to Bidirectional", "Add a back-reference when both classes need to navigate to each other."),
        ("Change Bidirectional Association to Unidirectional", "Remove a back-reference that one side no longer needs."),
        ("Encapsulate Field", "Make a public field private and add accessors."),
        ("Encapsulate Collection", "Return a read-only view of a collection and add add/remove methods."),
        ("Replace Magic Number with Symbolic Constant", "Name unexplained literals with a constant."),
        ("Replace Type Code with Class", "Replace a type-code primitive with a class (or enum) so values are type-checked."),
        ("Replace Type Code with Subclasses", "Use subclasses when a type code changes behaviour."),
        ("Replace Type Code with State/Strategy", "Use state/strategy objects when the type code can change at runtime."),
        ("Replace Subclass with Fields", "Collapse subclasses that only differ in constant-returning methods into fields."),
    ],
    "Simplifying Conditional Expressions": [
        ("Consolidate Conditional Expression", "Combine several conditions that lead to the same result into one well-named check."),
        ("Consolidate Duplicate Conditional Fragments", "Move code duplicated in every branch outside the conditional."),
        ("Decompose Conditional", "Extract a complicated condition and its branches into well-named methods."),
        ("Replace Conditional with Polymorphism", "Move each branch of a type-based conditional into an overriding method."),
        ("Remove Control Flag", "Use break/continue/return instead of a boolean variable that controls a loop."),
        ("Replace Nested Conditional with Guard Clauses", "Handle special cases early and return, flattening the happy path."),
        ("Introduce Null Object", "Return an object with do-nothing behaviour instead of null to remove null checks."),
        ("Introduce Assertion", "Make an assumption explicit with an assertion."),
    ],
    "Simplifying Method Calls": [
        ("Add Parameter", "Give a method the extra data it needs as a parameter."),
        ("Remove Parameter", "Delete a parameter the method no longer uses."),
        ("Rename Method", "Rename a method so its name says what it does."),
        ("Separate Query from Modifier", "Split a method that both returns a value and changes state into two."),
        ("Parameterize Method", "Merge similar methods that differ only by a value into one method with a parameter."),
        ("Introduce Parameter Object", "Replace a recurring group of parameters with one object."),
        ("Preserve Whole Object", "Pass the whole object instead of several values pulled from it."),
        ("Remove Setting Method", "Remove a setter for a field that should only be set at creation."),
        ("Replace Parameter with Explicit Methods", "Split a method that switches on a parameter into one method per case."),
        ("Replace Parameter with Method Call", "Let the method obtain a value itself instead of receiving it as a parameter."),
        ("Hide Method", "Make a method private (or protected) when nothing outside uses it."),
        ("Replace Constructor with Factory Method", "Use a static/named factory when construction needs more than a plain constructor."),
        ("Replace Error Code with Exception", "Throw an exception instead of returning a special error value."),
        ("Replace Exception with Test", "Check a condition up front instead of relying on catching an exception."),
    ],
    "Dealing with Generalization": [
        ("Pull Up Field", "Move a field shared by subclasses into the superclass."),
        ("Pull Up Method", "Move identical subclass methods into the superclass."),
        ("Pull Up Constructor Body", "Move shared constructor code into the superclass constructor."),
        ("Push Down Field", "Move a field used by only some subclasses down into them."),
        ("Push Down Method", "Move a method used by only some subclasses down into them."),
        ("Extract Subclass", "Create a subclass for features used only in some instances."),
        ("Extract Superclass", "Move common features of two classes into a new parent class."),
        ("Extract Interface", "Pull a shared subset of methods into an interface."),
        ("Collapse Hierarchy", "Merge a subclass into its parent when they're practically the same."),
        ("Form Template Method", "Turn similar algorithms in subclasses into a template method in the parent."),
        ("Replace Inheritance with Delegation", "Hold the former parent in a field and delegate, instead of inheriting from it."),
        ("Replace Delegation with Inheritance", "Inherit when a class delegates nearly everything to another."),
    ],
}

technique_ids = {slug(t) for g in TECHNIQUES.values() for t, _ in g}

smell_entries = []
for group, items in SMELLS.items():
    for title, summary, signs, fixes in items:
        missing = [f for f in fixes if f not in technique_ids]
        assert not missing, (title, missing)
        smell_entries.append({
            "id": slug(title), "title": title, "category": "Code Smells", "group": group,
            "summary": summary, "signs": signs, "related": fixes,
            "links": [{"label": f"{title} on refactoring.guru", "url": f"https://refactoring.guru/smells/{slug(title)}"}],
        })

# Which smells each technique helps with (reverse of the map above).
helps = {}
for s in smell_entries:
    for f in s["related"]:
        helps.setdefault(f, []).append(s["id"])

tech_entries = []
for group, items in TECHNIQUES.items():
    for title, summary in items:
        tid = slug(title)
        tech_entries.append({
            "id": tid, "title": title, "category": "Refactoring Techniques", "group": group,
            "summary": summary, "related": helps.get(tid, []),
            "links": [{"label": f"{title} on refactoring.guru", "url": f"https://refactoring.guru/{tid}"}],
        })

write("code-smells", {
    "id": "code-smells", "title": "Code Smells",
    "description": "Signs that code may need refactoring, grouped as on refactoring.guru. Each lists typical refactorings to apply.",
    "groups": list(SMELLS.keys()),
    "source": {"name": "refactoring.guru", "url": "https://refactoring.guru/refactoring/smells"},
    "entries": smell_entries,
})
write("refactoring-techniques", {
    "id": "refactoring-techniques", "title": "Refactoring Techniques",
    "description": "The refactoring catalog from refactoring.guru, one line each. Follow the links for step-by-step mechanics and examples.",
    "groups": list(TECHNIQUES.keys()),
    "source": {"name": "refactoring.guru", "url": "https://refactoring.guru/refactoring/catalog"},
    "entries": tech_entries,
})
