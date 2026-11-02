from common import ex, write

def A(id, title, group, summary, *, quote=None, details=None, when=None, pros=None, cons=None,
      examples=None, wild=None, related=None, links=None):
    e = {"id": id, "title": title, "category": "Architecture", "group": group, "summary": summary}
    if quote: e["quote"] = quote          # {text, source, url}, verified verbatim
    if details: e["solution"] = details
    if when: e["whenToUse"] = when
    if pros: e["pros"] = pros
    if cons: e["cons"] = cons
    if examples: e["examples"] = examples
    e["inTheWild"] = wild or []
    e["related"] = related or []
    e["links"] = links or []
    return e

entries = [
A("mvc", "MVC (Model–View–Controller)", "Application structure",
  "Separates data and rules (Model), presentation (View) and input handling (Controller), so each can change independently.",
  details="The controller receives a request, asks the model for data or to change state, and picks a view to present the result. Most server-side web frameworks use a variant of it.",
  pros=["Clear separation of concerns.", "Views and models can be tested and reused independently."],
  cons=["\"Fat controllers\" are easy to end up with. Push domain logic into models or services."],
  wild=[{"framework": "Laravel", "note": "Routes dispatch to controllers, which use Eloquent models and return Blade views (or JSON).", "url": "https://laravel.com/docs/controllers"}],
  related=["mtv", "mvvm", "layered-architecture", "service-layer"]),

A("mtv", "MTV (Model–Template–View)", "Application structure",
  "Django's naming of MVC. The *view* decides which data is shown, the *template* decides how it looks, and the framework itself plays the controller.",
  quote={"text": "If you're hungry for acronyms, you might say that Django is a \"MTV\" framework – that is, \"model\", \"template\", and \"view.\"",
         "source": "Django FAQ", "url": "https://docs.djangoproject.com/en/stable/faq/general/"},
  details="In Django's interpretation, a view is the Python callback for a URL and describes which data you see. It usually delegates to a template, which describes how you see it. The URL dispatcher (the framework) routes requests to views.",
  related=["mvc", "template-method"]),

A("mvvm", "MVVM (Model–View–ViewModel)", "Application structure",
  "Views render UI and forward events. View models hold UI state and expose data and commands. Models (repositories and services) own the data.",
  details="Views stay free of business logic. View models transform model data for display and expose commands the view calls. Repositories are the source of truth for data, and services wrap data sources like APIs.",
  wild=[{"framework": "Flutter", "note": "Flutter's official architecture guide recommends MVVM: a UI layer (views + view models), a data layer (repositories + services), and an optional domain layer of use-cases added \"only when needed\".",
         "url": "https://docs.flutter.dev/app-architecture/guide"}],
  related=["mvc", "repository", "command", "observer"]),

A("layered-architecture", "Layered Architecture", "Application structure",
  "Organise code into horizontal layers (e.g. presentation → application/service → domain → data access), where each layer only depends on the ones below it.",
  pros=["Easy to understand and widely familiar.", "Layers can be replaced or tested in isolation."],
  cons=["Changes to a feature often cut across every layer.", "Domain logic can leak into services, leaving an 'anaemic' domain."],
  related=["clean-architecture", "hexagonal-architecture", "service-layer", "separation-of-concerns"]),

A("clean-architecture", "Clean Architecture", "Application structure",
  "Arrange code in concentric circles with business rules at the centre and frameworks, UI and databases at the edge, with dependencies only pointing inward.",
  quote={"text": "This rule says that source code dependencies can only point inwards.",
         "source": "Robert C. Martin, The Clean Architecture (the Dependency Rule)",
         "url": "https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html"},
  details="The circles, inside out: Entities, Use Cases, Interface Adapters, Frameworks and Drivers. Inner circles know nothing about outer ones. They define interfaces that outer layers implement (dependency inversion).",
  pros=["Business rules are independent of frameworks, UI and database.", "Core logic is easy to unit test."],
  cons=["More interfaces and mapping code.", "Overkill for CRUD-heavy apps."],
  related=["hexagonal-architecture", "dependency-inversion-principle", "layered-architecture", "repository"]),

A("hexagonal-architecture", "Hexagonal Architecture (Ports & Adapters)", "Application structure",
  "The application core talks to the outside world only through ports (interfaces). Adapters plug specific technologies (web, CLI, DB, tests) into those ports.",
  quote={"text": "Allow an application to equally be driven by users, programs, automated test or batch scripts, and to be developed and tested in isolation from its eventual run-time devices and databases.",
         "source": "Alistair Cockburn, Hexagonal Architecture (intent)", "url": "https://alistair.cockburn.us/hexagonal-architecture/"},
  details="A port is a purposeful conversation the app has with the outside, expressed as an API. An adapter translates between a port and a specific technology, such as an HTTP controller, a database gateway or a test harness.",
  pros=["Swap infrastructure without touching the core.", "Drive the whole app from tests."],
  cons=["Extra indirection for simple apps."],
  related=["clean-architecture", "adapter", "dependency-inversion-principle"]),

A("repository", "Repository", "Data & domain",
  "A collection-like interface for loading and saving domain objects that hides how they're stored.",
  quote={"text": "Mediates between the domain and data mapping layers using a collection-like interface for accessing domain objects.",
         "source": "Martin Fowler, Patterns of Enterprise Application Architecture", "url": "https://martinfowler.com/eaaCatalog/repository.html"},
  pros=["Domain code doesn't depend on the ORM/SQL.", "Easy to swap with an in-memory fake in tests."],
  cons=["With an Active Record ORM it can become a thin pass-through that adds little."],
  examples=ex(php="""
    interface InvoiceRepository {
        public function find(InvoiceId $id): ?Invoice;
        public function overdue(\\DateTimeImmutable $asOf): array;
        public function save(Invoice $invoice): void;
    }
    """, python="""
    class InvoiceRepository(Protocol):
        def find(self, invoice_id: int) -> Invoice | None: ...
        def overdue(self, as_of: date) -> list[Invoice]: ...
        def save(self, invoice: Invoice) -> None: ...
    """, dart="""
    abstract interface class InvoiceRepository {
      Future<Invoice?> find(int id);
      Future<List<Invoice>> overdue(DateTime asOf);
      Future<void> save(Invoice invoice);
    }
    """),
  wild=[{"framework": "Flutter", "note": "In the architecture guide, \"Repository classes are the source of truth for your model data\". They poll services, cache, handle errors and turn raw data into domain models.",
         "url": "https://docs.flutter.dev/app-architecture/guide"}],
  related=["active-record", "service-layer", "clean-architecture", "decorator"]),

A("active-record", "Active Record", "Data & domain",
  "Each object wraps a database row and knows how to load, save and delete itself, alongside its domain logic.",
  quote={"text": "An object that wraps a row in a database table or view, encapsulates the database access, and adds domain logic on that data.",
         "source": "Martin Fowler, Patterns of Enterprise Application Architecture", "url": "https://martinfowler.com/eaaCatalog/activeRecord.html"},
  pros=["Very little code for CRUD.", "Intuitive: the model is the table row."],
  cons=["Domain logic is coupled to persistence.", "Large models can become god objects."],
  wild=[{"framework": "Laravel", "note": "Eloquent works this way. The docs describe it as an ORM where \"each database table has a corresponding 'Model'\" used to retrieve, insert, update and delete records (e.g. `$user->save()`).",
         "url": "https://laravel.com/docs/eloquent"}],
  related=["repository", "large-class"]),

A("service-layer", "Service Layer", "Data & domain",
  "A layer of application services that defines the operations your app offers (e.g. `PlaceOrder`, `RefundPayment`) and coordinates domain objects, transactions and side effects.",
  quote={"text": "Defines an application's boundary with a layer of services that establishes a set of available operations",
         "source": "Martin Fowler, Patterns of Enterprise Application Architecture (excerpt)", "url": "https://martinfowler.com/eaaCatalog/serviceLayer.html"},
  pros=["Controllers, CLI commands and jobs share one implementation.", "Clear place for transactions and orchestration."],
  cons=["Can absorb all logic, leaving models as plain data (anaemic domain)."],
  related=["facade", "repository", "layered-architecture", "mvc"]),

A("dependency-injection", "Dependency Injection", "Data & domain",
  "Objects receive their collaborators from outside (usually through the constructor) instead of creating them, so implementations can be swapped and mocked.",
  pros=["Loose coupling and easy testing.", "A container can manage lifetimes (singleton, per-request)."],
  cons=["Indirection: harder to find which implementation runs.", "Containers can hide over-large constructors."],
  wild=[{"framework": "Laravel", "note": "The service container is \"a powerful tool for managing class dependencies and performing dependency injection\". Controllers, listeners, middleware and jobs get dependencies auto-injected by type-hint.",
         "url": "https://laravel.com/docs/container"}],
  related=["dependency-inversion-principle", "singleton", "strategy"]),

A("cqrs", "CQRS", "Data & domain",
  "Command Query Responsibility Segregation: use one model to change data and a different model to read it.",
  quote={"text": "use a different model to update information than the model you use to read information",
         "source": "Martin Fowler, CQRS", "url": "https://martinfowler.com/bliki/CQRS.html"},
  details="Fowler cautions that for most systems CQRS adds risky complexity, and that it should be applied to specific parts of a system rather than the whole.",
  pros=["Read and write sides can be optimised and scaled separately."],
  cons=["Significant extra complexity.", "Often paired with eventual consistency."],
  related=["event-sourcing", "separate-query-from-modifier"]),

A("event-sourcing", "Event Sourcing", "Data & domain",
  "Store every change as an immutable event and derive current state by replaying them, instead of storing only the latest state.",
  quote={"text": "Capture all changes to an application state as a sequence of events.",
         "source": "Martin Fowler, Event Sourcing", "url": "https://martinfowler.com/eaaDev/EventSourcing.html"},
  pros=["Full audit history.", "Rebuild state or new read models by replaying."],
  cons=["Event schema evolution is hard.", "More infrastructure (projections, snapshots)."],
  related=["cqrs", "observer", "memento"]),

A("modular-monolith", "Modular Monolith", "System structure",
  "One deployable application, split internally into modules with clear boundaries and explicit interfaces between them.",
  pros=["Simple deployment and debugging.", "Module boundaries make a later split into services possible."],
  cons=["Boundaries need discipline (or tooling) to stay enforced."],
  related=["microservices", "separation-of-concerns"]),

A("microservices", "Microservices", "System structure",
  "Build one application as a suite of small, independently deployable services, organised around business capabilities.",
  quote={"text": "the microservice architectural style is an approach to developing a single application as a suite of small services, each running in its own process and communicating with lightweight mechanisms, often an HTTP resource API.",
         "source": "James Lewis & Martin Fowler, Microservices", "url": "https://martinfowler.com/articles/microservices.html"},
  pros=["Independent deployment and scaling.", "Teams own services end to end."],
  cons=["Distributed-systems complexity: network failures, data consistency, observability.", "Operational overhead."],
  related=["modular-monolith", "twelve-factor-processes", "twelve-factor-port-binding"]),
]

write("architecture", {
    "id": "architecture", "title": "Architecture",
    "description": "Application and system architecture styles. Definitions are quoted from their original sources where noted; framework notes are checked against official docs.",
    "groups": ["Application structure", "Data & domain", "System structure"],
    "entries": entries,
})

# ─────────────────────────── Principles ───────────────────────────
def R(id, title, group, summary, *, quote=None, details=None, examples=None, related=None, links=None):
    e = {"id": id, "title": title, "category": "Principles & Best Practices", "group": group, "summary": summary}
    if quote: e["quote"] = quote
    if details: e["solution"] = details
    if examples: e["examples"] = examples
    e["related"] = related or []
    e["links"] = links or []
    return e

principles = [
R("single-responsibility-principle", "Single Responsibility Principle (SRP)", "SOLID",
  "A module should have one reason to change. Group code that changes for the same reasons, and separate code that changes for different reasons.",
  quote={"text": "Gather together the things that change for the same reasons. Separate those things that change for different reasons.",
         "source": "Robert C. Martin, The Single Responsibility Principle",
         "url": "https://blog.cleancoder.com/uncle-bob/2014/05/08/SingleReponsibilityPrinciple.html"},
  details="Martin stresses that the principle \"is about people\": the reasons for change are the different people or roles who ask for changes.",
  related=["large-class", "divergent-change", "extract-class", "separation-of-concerns"]),
R("open-closed-principle", "Open/Closed Principle (OCP)", "SOLID",
  "Software should be open for extension but closed for modification. Add behaviour by adding code (new classes or strategies), not by editing working code.",
  related=["strategy", "decorator", "replace-conditional-with-polymorphism"]),
R("liskov-substitution-principle", "Liskov Substitution Principle (LSP)", "SOLID",
  "Subtypes must be usable anywhere their base type is expected without breaking correctness. Don't strengthen preconditions or weaken guarantees in a subclass.",
  details="Named after Barbara Liskov. A classic violation is a subclass that throws on a method its parent supports, which is the Refused Bequest smell.",
  related=["refused-bequest", "replace-inheritance-with-delegation"]),
R("interface-segregation-principle", "Interface Segregation Principle (ISP)", "SOLID",
  "Clients shouldn't be forced to depend on methods they don't use. Prefer several small, focused interfaces over one large one.",
  related=["extract-interface", "large-class"]),
R("dependency-inversion-principle", "Dependency Inversion Principle (DIP)", "SOLID",
  "High-level policy shouldn't depend on low-level details. Both should depend on abstractions (interfaces), and the details implement them.",
  related=["dependency-injection", "clean-architecture", "hexagonal-architecture"]),
R("dry", "DRY (Don't Repeat Yourself)", "General",
  "Every piece of knowledge should have a single, authoritative representation in the system. It's about duplicated *knowledge*, not every similar-looking line of code.",
  details="From *The Pragmatic Programmer* (Hunt & Thomas). Merging code that only looks alike but changes for different reasons creates harmful coupling.",
  related=["duplicate-code", "extract-method", "single-responsibility-principle"]),
R("kiss", "KISS (Keep It Simple)", "General",
  "Prefer the simplest design that solves the problem. Complexity should be justified by an actual need.",
  related=["yagni", "speculative-generality"]),
R("yagni", "YAGNI (You Aren't Gonna Need It)", "General",
  "Don't build a capability now because you think you'll need it later. Build it when you actually do.",
  quote={"text": "Yagni only applies to capabilities built into the software to support a presumptive feature, it does not apply to effort to make the software easier to modify.",
         "source": "Martin Fowler, Yagni", "url": "https://martinfowler.com/bliki/Yagni.html"},
  details="Refactoring to keep code easy to change is not a YAGNI violation. Speculative features and abstractions are.",
  related=["kiss", "speculative-generality"]),
R("law-of-demeter", "Law of Demeter", "General",
  "\"Talk only to your immediate friends\": a method should call methods on itself, its parameters, objects it creates and its direct fields, not reach through chains of other objects.",
  related=["message-chains", "hide-delegate", "feature-envy"]),
R("composition-over-inheritance", "Composition over Inheritance", "General",
  "Build behaviour by combining small objects rather than through deep class hierarchies, which are rigid and tightly coupled.",
  related=["decorator", "strategy", "replace-inheritance-with-delegation", "composite"]),
R("separation-of-concerns", "Separation of Concerns", "General",
  "Divide a program into distinct parts that each address one concern (UI, domain rules, persistence, I/O), so they can change independently.",
  related=["single-responsibility-principle", "layered-architecture", "mvc"]),
R("fail-fast", "Fail Fast", "General",
  "Detect invalid states and inputs as early as possible and stop loudly, instead of continuing with bad data that fails confusingly later.",
  related=["introduce-assertion", "replace-nested-conditional-with-guard-clauses"]),
]

# Twelve-Factor App: names and taglines verified against 12factor.net
FACTORS = [
    ("I", "Codebase", "codebase", "One codebase tracked in revision control, many deploys"),
    ("II", "Dependencies", "dependencies", "Explicitly declare and isolate dependencies"),
    ("III", "Config", "config", "Store config in the environment"),
    ("IV", "Backing services", "backing-services", "Treat backing services as attached resources"),
    ("V", "Build, release, run", "build-release-run", "Strictly separate build and run stages"),
    ("VI", "Processes", "processes", "Execute the app as one or more stateless processes"),
    ("VII", "Port binding", "port-binding", "Export services via port binding"),
    ("VIII", "Concurrency", "concurrency", "Scale out via the process model"),
    ("IX", "Disposability", "disposability", "Maximize robustness with fast startup and graceful shutdown"),
    ("X", "Dev/prod parity", "dev-prod-parity", "Keep development, staging, and production as similar as possible"),
    ("XI", "Logs", "logs", "Treat logs as event streams"),
    ("XII", "Admin processes", "admin-processes", "Run admin/management tasks as one-off processes"),
]
FACTOR_NOTES = {
    "dependencies": "composer.json + composer.lock, requirements.txt / pyproject.toml, pubspec.yaml + pubspec.lock.",
    "config": "Credentials and per-environment settings belong in environment variables (Laravel's and Django's `.env` conventions), not in code.",
    "backing-services": "Databases, Redis, mail and queues are swapped by changing config (a URL/credentials), not code.",
    "processes": "Keep no sticky state in memory or on local disk between requests. Use a database, cache or object storage.",
    "logs": "Write to stdout/stderr and let the environment route and store logs.",
    "admin-processes": "Migrations and one-off scripts (`php artisan migrate`, `python manage.py migrate`) run against the same release and config as the app.",
}
for num, name, slug_, tagline in FACTORS:
    principles.append({
        "id": f"twelve-factor-{slug_}", "title": f"{num}. {name}", "category": "Principles & Best Practices", "group": "Twelve-Factor App",
        "summary": tagline + ".",
        **({"solution": FACTOR_NOTES[slug_]} if slug_ in FACTOR_NOTES else {}),
        "related": [], "links": [{"label": f"12factor.net: {name}", "url": f"https://12factor.net/{slug_}"}],
    })

write("principles", {
    "id": "principles", "title": "Principles & Best Practices",
    "description": "SOLID, general design principles and the Twelve-Factor App methodology.",
    "groups": ["SOLID", "General", "Twelve-Factor App"],
    "entries": principles,
})
