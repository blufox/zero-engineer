from common import ex, write

RG = "https://refactoring.guru/design-patterns/"

def P(id, title, group, summary, problem, solution, when, pros, cons, examples, related, wild=None):
    return {
        "id": id, "title": title, "category": "Design Patterns", "group": group,
        "summary": summary, "problem": problem, "solution": solution,
        "whenToUse": when, "pros": pros, "cons": cons, "examples": examples,
        "inTheWild": wild or [], "related": related,
        "links": [{"label": f"{title} on refactoring.guru", "url": RG + id}],
    }

LARAVEL_CONTAINER = "https://laravel.com/docs/container"

entries = [
# ─────────────────────────── Creational ───────────────────────────
P("factory-method", "Factory Method", "Creational",
  "Let subclasses decide which concrete class to create, by calling an overridable creation method instead of `new`.",
  "Code that calls `new ConcreteThing()` directly is tied to that class; adding a new variant means editing every place that creates one.",
  "Move creation into a method (the factory method) on a base class. Subclasses override it to return a different product that shares a common interface.",
  ["You don't know ahead of time which exact types your code must work with.",
   "You want framework users to extend internal components by subclassing.",
   "You want one place to change which product gets built."],
  ["Decouples creators from concrete products.", "Single place for creation logic (SRP).", "New products without touching client code (OCP)."],
  ["Can lead to many parallel subclasses just to create objects."],
  ex(php="""
    interface Channel { public function deliver(string $msg): void; }
    final class SmsChannel implements Channel {
        public function deliver(string $msg): void { /* send SMS */ }
    }

    abstract class Notifier {
        abstract protected function createChannel(): Channel; // the factory method

        public function notify(string $msg): void {
            $this->createChannel()->deliver($msg);
        }
    }

    final class SmsNotifier extends Notifier {
        protected function createChannel(): Channel { return new SmsChannel(); }
    }
    """, python="""
    from abc import ABC, abstractmethod

    class Channel(ABC):
        @abstractmethod
        def deliver(self, msg: str) -> None: ...

    class SmsChannel(Channel):
        def deliver(self, msg: str) -> None: ...  # send SMS

    class Notifier(ABC):
        @abstractmethod
        def create_channel(self) -> Channel: ...  # the factory method

        def notify(self, msg: str) -> None:
            self.create_channel().deliver(msg)

    class SmsNotifier(Notifier):
        def create_channel(self) -> Channel:
            return SmsChannel()
    """, dart="""
    abstract interface class Channel { void deliver(String msg); }
    class SmsChannel implements Channel {
      @override
      void deliver(String msg) { /* send SMS */ }
    }

    abstract class Notifier {
      Channel createChannel(); // the factory method

      void notify(String msg) => createChannel().deliver(msg);
    }

    class SmsNotifier extends Notifier {
      @override
      Channel createChannel() => SmsChannel();
    }
    """),
  ["abstract-factory", "template-method", "prototype"]),

P("abstract-factory", "Abstract Factory", "Creational",
  "Create whole families of related objects through one interface, without naming their concrete classes.",
  "Objects must be used together as a matching set (e.g. a dark-theme button with a dark-theme dialog) and mixing families causes bugs.",
  "Define a factory interface with one creation method per product. Each concrete factory produces one consistent family; client code only sees the interfaces.",
  ["Your code must work with several families of related products.",
   "You want to guarantee products from the same family are used together."],
  ["Products from a factory are compatible with each other.", "Client code is decoupled from concrete products.", "Easy to swap an entire family at once."],
  ["Adding a new kind of product means changing the factory interface and every factory."],
  ex(php="""
    interface Button { public function render(): string; }
    interface Dialog { public function render(): string; }

    interface UiFactory {
        public function button(): Button;
        public function dialog(): Dialog;
    }

    final class DarkUi implements UiFactory {
        public function button(): Button { return new DarkButton(); }
        public function dialog(): Dialog { return new DarkDialog(); }
    }

    function confirmScreen(UiFactory $ui): string {
        return $ui->dialog()->render() . $ui->button()->render();
    }
    """, python="""
    from typing import Protocol

    class Button(Protocol):
        def render(self) -> str: ...

    class Dialog(Protocol):
        def render(self) -> str: ...

    class UiFactory(Protocol):
        def button(self) -> Button: ...
        def dialog(self) -> Dialog: ...

    class DarkUi:
        def button(self) -> Button: return DarkButton()
        def dialog(self) -> Dialog: return DarkDialog()

    def confirm_screen(ui: UiFactory) -> str:
        return ui.dialog().render() + ui.button().render()
    """, dart="""
    abstract interface class Button { String render(); }
    abstract interface class Dialog { String render(); }

    abstract interface class UiFactory {
      Button button();
      Dialog dialog();
    }

    class DarkUi implements UiFactory {
      @override
      Button button() => DarkButton();
      @override
      Dialog dialog() => DarkDialog();
    }

    String confirmScreen(UiFactory ui) => ui.dialog().render() + ui.button().render();
    """),
  ["factory-method", "builder", "singleton"]),

P("builder", "Builder", "Creational",
  "Construct a complex object step by step, so the same construction process can produce different results.",
  "A constructor with many optional parameters (\"telescoping constructor\") is hard to read and easy to call wrongly.",
  "Move construction into a builder with one method per step. Callers chain only the steps they need, then call `build()` to get the finished object.",
  ["An object has many optional parts or configuration options.",
   "You want to build different representations with the same steps.",
   "You want construction to be readable at the call site."],
  ["Readable, self-documenting construction.", "Can validate before producing the object.", "Isolates complex construction code."],
  ["More classes/code than a plain constructor."],
  ex(php="""
    final class HttpRequestBuilder {
        private string $method = 'GET';
        private array $headers = [];
        private ?string $body = null;

        public function __construct(private string $url) {}

        public function method(string $m): static { $this->method = $m; return $this; }
        public function header(string $k, string $v): static { $this->headers[$k] = $v; return $this; }
        public function json(array $data): static {
            $this->body = json_encode($data);
            return $this->header('Content-Type', 'application/json');
        }
        public function build(): HttpRequest {
            return new HttpRequest($this->method, $this->url, $this->headers, $this->body);
        }
    }

    $req = (new HttpRequestBuilder('https://api.test/users'))
        ->method('POST')->json(['name' => 'Ada'])->build();
    """, python="""
    class HttpRequestBuilder:
        def __init__(self, url: str):
            self._url, self._method, self._headers, self._body = url, "GET", {}, None

        def method(self, m: str) -> "HttpRequestBuilder":
            self._method = m
            return self

        def header(self, k: str, v: str) -> "HttpRequestBuilder":
            self._headers[k] = v
            return self

        def build(self) -> "HttpRequest":
            return HttpRequest(self._method, self._url, self._headers, self._body)

    req = HttpRequestBuilder("https://api.test/users").method("POST").header("Accept", "application/json").build()
    """, dart="""
    // Dart's cascade operator (..) gives builder-style chaining on any mutable object.
    class HttpRequestBuilder {
      HttpRequestBuilder(this.url);
      final String url;
      String method = 'GET';
      final headers = <String, String>{};

      HttpRequest build() => HttpRequest(method, url, Map.unmodifiable(headers));
    }

    final req = (HttpRequestBuilder('https://api.test/users')
          ..method = 'POST'
          ..headers['Accept'] = 'application/json')
        .build();
    """),
  ["abstract-factory", "composite"],
  wild=[{"framework": "Django", "note": "QuerySets are refined step by step and run lazily: \"The result of refining a QuerySet is itself a QuerySet, so it's possible to chain refinements together.\" This is builder-like, with the query only executing when evaluated.",
         "url": "https://docs.djangoproject.com/en/stable/topics/db/queries/"}]),

P("prototype", "Prototype", "Creational",
  "Create new objects by copying an existing one, instead of building them from scratch.",
  "Recreating an object can be expensive or impossible from outside (private state), and the caller may only know an interface.",
  "Give objects a way to clone themselves. Callers copy a pre-configured prototype and tweak the copy.",
  ["Objects are costly to create but cheap to copy.", "You want copies without depending on concrete classes."],
  ["Clone without coupling to concrete classes.", "Pre-configured prototypes replace subclasses that only differ in setup."],
  ["Deep-copying objects with circular references is tricky."],
  ex(php="""
    final class Invoice {
        public function __construct(public array $lines, public \\DateTimeImmutable $date) {}

        // PHP's clone is shallow; deep-copy mutable members here.
        public function __clone() {
            $this->lines = array_map(fn ($l) => clone $l, $this->lines);
        }
    }

    $copy = clone $template;   // then adjust the copy
    """, python="""
    import copy

    template = Invoice(lines=[Line("Hosting", 100)], date=date.today())
    draft = copy.deepcopy(template)   # independent copy, nested objects included
    draft.lines.append(Line("Support", 50))
    """, dart="""
    class Invoice {
      const Invoice({required this.lines, required this.date});
      final List<Line> lines;
      final DateTime date;

      // The idiomatic Dart/Flutter take: copyWith on immutable objects.
      Invoice copyWith({List<Line>? lines, DateTime? date}) =>
          Invoice(lines: lines ?? List.of(this.lines), date: date ?? this.date);
    }

    final next = invoice.copyWith(date: DateTime.now());
    """),
  ["factory-method", "memento"]),

P("singleton", "Singleton", "Creational",
  "Ensure a class has only one instance and provide a global access point to it.",
  "Some resources should exist once (a config registry, a connection pool), and creating several causes inconsistency or waste.",
  "Hide the constructor and expose a static accessor that creates the instance on first use and returns it afterwards.",
  ["Exactly one shared instance must exist.", "You need stricter control than a global variable."],
  ["Guaranteed single instance.", "Lazy initialisation."],
  ["Global state hides dependencies and makes testing harder.", "Violates SRP (manages its own lifecycle).", "Usually better solved with a DI container managing lifetime."],
  ex(php="""
    final class Config {
        private static ?Config $instance = null;
        private function __construct(private array $values) {}

        public static function instance(): Config {
            return self::$instance ??= new Config(require 'config.php');
        }
    }
    """, python="""
    # Python modules are imported once and cached (sys.modules), so a
    # module-level object is the simplest "singleton":
    # config.py
    settings = load_settings()

    # elsewhere
    from config import settings
    """, dart="""
    class Config {
      Config._internal();
      static final Config _instance = Config._internal();

      // A factory constructor can return the existing instance.
      factory Config() => _instance;
    }

    void main() {
      assert(identical(Config(), Config()));
    }
    """),
  ["facade", "flyweight", "dependency-injection"],
  wild=[{"framework": "Laravel", "note": "The service container's `singleton` binding resolves a class once and returns the same instance on later calls. `scoped` does the same per request or job lifecycle. The container manages the lifetime, so the class itself stays an ordinary, testable class.",
         "url": LARAVEL_CONTAINER + "#binding-a-singleton"}]),

# ─────────────────────────── Structural ───────────────────────────
P("adapter", "Adapter", "Structural",
  "Let objects with incompatible interfaces work together by wrapping one in a translator.",
  "You want to use a third-party or legacy class, but its interface doesn't match what your code expects.",
  "Write an adapter that implements your interface and translates calls to the wrapped object's API.",
  ["Integrating a library or legacy code whose interface you can't change.", "Several classes need the same missing behaviour behind a common interface."],
  ["Keeps conversion code out of business logic (SRP).", "Swap implementations behind your own interface (OCP)."],
  ["An extra layer of indirection."],
  ex(php="""
    interface PaymentGateway { public function charge(int $cents, string $token): string; }

    final class StripeAdapter implements PaymentGateway {
        public function __construct(private StripeClient $stripe) {}

        public function charge(int $cents, string $token): string {
            $charge = $this->stripe->charges->create(['amount' => $cents, 'currency' => 'usd', 'source' => $token]);
            return $charge->id;
        }
    }
    """, python="""
    class PaymentGateway(Protocol):
        def charge(self, cents: int, token: str) -> str: ...

    class LegacyBankAdapter:
        def __init__(self, bank: LegacyBankApi):
            self._bank = bank

        def charge(self, cents: int, token: str) -> str:
            # legacy API wants rands as a float and returns a dict
            result = self._bank.make_payment(amount=cents / 100, card_ref=token)
            return result["reference"]
    """, dart="""
    abstract interface class PaymentGateway {
      Future<String> charge(int cents, String token);
    }

    class LegacyBankAdapter implements PaymentGateway {
      LegacyBankAdapter(this._bank);
      final LegacyBankApi _bank;

      @override
      Future<String> charge(int cents, String token) async {
        final result = await _bank.makePayment(amount: cents / 100, cardRef: token);
        return result['reference'] as String;
      }
    }
    """),
  ["bridge", "decorator", "facade", "proxy"]),

P("bridge", "Bridge", "Structural",
  "Split a class that varies in two independent ways into two hierarchies, abstraction and implementation, connected by composition.",
  "Extending a class in two dimensions (e.g. report type × export format) by inheritance explodes into every combination of subclasses.",
  "Keep one dimension as the abstraction and move the other into a separate interface that the abstraction holds a reference to.",
  ["A class varies along two or more independent axes.", "You need to switch implementations at runtime."],
  ["Avoids a combinatorial explosion of subclasses.", "Abstraction and implementation evolve independently."],
  ["More indirection; can over-complicate a cohesive class."],
  ex(php="""
    interface Exporter { public function export(array $rows): string; }
    final class CsvExporter implements Exporter { /* ... */ }
    final class PdfExporter implements Exporter { /* ... */ }

    abstract class Report {
        public function __construct(protected Exporter $exporter) {}  // the bridge
        abstract protected function rows(): array;
        public function render(): string { return $this->exporter->export($this->rows()); }
    }

    final class SalesReport extends Report { protected function rows(): array { /* ... */ } }

    (new SalesReport(new PdfExporter()))->render();
    """, python="""
    class Exporter(Protocol):
        def export(self, rows: list[dict]) -> bytes: ...

    class Report(ABC):
        def __init__(self, exporter: Exporter):
            self.exporter = exporter   # the bridge

        @abstractmethod
        def rows(self) -> list[dict]: ...

        def render(self) -> bytes:
            return self.exporter.export(self.rows())

    SalesReport(CsvExporter()).render()
    """, dart="""
    abstract interface class Exporter { String export(List<Map<String, Object?>> rows); }

    abstract class Report {
      Report(this.exporter); // the bridge
      final Exporter exporter;

      List<Map<String, Object?>> rows();
      String render() => exporter.export(rows());
    }

    class SalesReport extends Report {
      SalesReport(super.exporter);
      @override
      List<Map<String, Object?>> rows() => [];
    }
    """),
  ["adapter", "strategy", "abstract-factory"]),

P("composite", "Composite", "Structural",
  "Compose objects into tree structures and treat individual objects and groups the same way.",
  "Code has to handle both single items and containers of items (files and folders, menu items and sub-menus) with lots of type checks.",
  "Give leaves and containers a common interface. Containers implement operations by delegating to their children and combining the results.",
  ["Your model is naturally a tree.", "Clients should treat leaves and branches uniformly."],
  ["Work with complex trees through one interface.", "Add new element types without changing client code."],
  ["A single interface can become too general for very different elements."],
  ex(php="""
    interface Node { public function size(): int; }

    final class File implements Node {
        public function __construct(private int $bytes) {}
        public function size(): int { return $this->bytes; }
    }

    final class Folder implements Node {
        /** @param Node[] $children */
        public function __construct(private array $children = []) {}
        public function size(): int {
            return array_sum(array_map(fn (Node $n) => $n->size(), $this->children));
        }
    }
    """, python="""
    class Node(Protocol):
        def size(self) -> int: ...

    @dataclass
    class File:
        bytes: int
        def size(self) -> int: return self.bytes

    @dataclass
    class Folder:
        children: list[Node]
        def size(self) -> int: return sum(c.size() for c in self.children)
    """, dart="""
    sealed class Node { int get size; }

    class File extends Node {
      File(this.bytes);
      final int bytes;
      @override
      int get size => bytes;
    }

    class Folder extends Node {
      Folder(this.children);
      final List<Node> children;
      @override
      int get size => children.fold(0, (sum, c) => sum + c.size);
    }
    """),
  ["decorator", "iterator", "visitor", "builder"],
  wild=[{"framework": "Flutter", "note": "Widgets form a tree built by composition: \"Widgets form a hierarchy based on composition.\" A Container is itself made of smaller layout, painting and positioning widgets.",
         "url": "https://docs.flutter.dev/resources/architectural-overview"}]),

P("decorator", "Decorator", "Structural",
  "Attach extra behaviour to an object by wrapping it in another object with the same interface.",
  "Adding features through subclassing (logging, caching, retries) leads to rigid hierarchies and can't be combined at runtime.",
  "Wrap the object in a decorator that implements the same interface, adds its behaviour, and delegates the rest to the wrapped object. Decorators can be stacked.",
  ["Add responsibilities to individual objects at runtime.", "Combine several optional behaviours (cache + log + retry).", "Subclassing is impractical or impossible (final classes)."],
  ["Mix and match behaviours at runtime.", "Each concern lives in its own small class (SRP)."],
  ["Order of wrapping matters and can be confusing.", "Many small wrapper objects."],
  ex(php="""
    interface UserRepository { public function find(int $id): ?User; }

    final class CachedUserRepository implements UserRepository {
        public function __construct(private UserRepository $inner, private CacheInterface $cache) {}

        public function find(int $id): ?User {
            return $this->cache->remember("user:$id", 300, fn () => $this->inner->find($id));
        }
    }

    $repo = new CachedUserRepository(new EloquentUserRepository(), $cache);
    """, python="""
    class CachedUserRepository:
        def __init__(self, inner: UserRepository, cache: Cache):
            self._inner, self._cache = inner, cache

        def find(self, user_id: int) -> User | None:
            key = f"user:{user_id}"
            if (hit := self._cache.get(key)) is not None:
                return hit
            user = self._inner.find(user_id)
            self._cache.set(key, user, timeout=300)
            return user

    # Note: Python's @decorator syntax wraps *functions*. Same idea, different level.
    """, dart="""
    class CachedUserRepository implements UserRepository {
      CachedUserRepository(this._inner);
      final UserRepository _inner;
      final _cache = <int, User?>{};

      @override
      Future<User?> find(int id) async =>
          _cache.containsKey(id) ? _cache[id] : (_cache[id] = await _inner.find(id));
    }
    """),
  ["adapter", "proxy", "composite", "chain-of-responsibility", "strategy"],
  wild=[{"framework": "Laravel", "note": "The container's `extend` method lets you decorate a resolved service. The docs' own example returns `new DecoratedService($service)`.",
         "url": LARAVEL_CONTAINER + "#extending-bindings"}]),

P("facade", "Facade", "Structural",
  "Provide one simplified interface to a complex subsystem.",
  "Using a subsystem means wiring together many classes in the right order, and that knowledge leaks into every caller.",
  "Create a facade class with a few high-level methods that coordinate the subsystem internally. Callers depend on the facade only.",
  ["You need a simple entry point to a complex library or module.", "You want to layer a subsystem and reduce coupling to its internals."],
  ["Isolates clients from subsystem complexity.", "One place to change how the subsystem is used."],
  ["Can grow into a god object coupled to everything."],
  ex(php="""
    final class VideoPublisher {
        public function __construct(
            private Transcoder $transcoder,
            private ThumbnailGenerator $thumbs,
            private CdnUploader $cdn,
        ) {}

        public function publish(string $path): string {
            $mp4 = $this->transcoder->toMp4($path);
            $this->cdn->upload($this->thumbs->fromVideo($mp4));
            return $this->cdn->upload($mp4);
        }
    }
    """, python="""
    class VideoPublisher:
        def __init__(self, transcoder, thumbs, cdn):
            self._transcoder, self._thumbs, self._cdn = transcoder, thumbs, cdn

        def publish(self, path: str) -> str:
            mp4 = self._transcoder.to_mp4(path)
            self._cdn.upload(self._thumbs.from_video(mp4))
            return self._cdn.upload(mp4)
    """, dart="""
    class VideoPublisher {
      VideoPublisher(this._transcoder, this._thumbs, this._cdn);
      final Transcoder _transcoder;
      final ThumbnailGenerator _thumbs;
      final CdnUploader _cdn;

      Future<String> publish(String path) async {
        final mp4 = await _transcoder.toMp4(path);
        await _cdn.upload(await _thumbs.fromVideo(mp4));
        return _cdn.upload(mp4);
      }
    }
    """),
  ["adapter", "mediator", "proxy", "singleton"],
  wild=[{"framework": "Laravel", "note": "Careful, the name is shared but the pattern is different. Laravel's \"facades\" (Cache::get(), Route::get()) are \"static proxies\" to services in the container: a static-looking API that forwards calls via `__callStatic()`. That's closer to the Proxy pattern than to a GoF Facade.",
         "url": "https://laravel.com/docs/facades"}]),

P("flyweight", "Flyweight", "Structural",
  "Fit more objects in memory by sharing the common (intrinsic) state between them instead of storing it in each one.",
  "Huge numbers of similar objects (map markers, particles, glyphs) each duplicate the same heavy data and exhaust memory.",
  "Split state into shared intrinsic state (stored once in a flyweight from a factory/cache) and per-object extrinsic state passed in by the caller.",
  ["You must create a very large number of similar objects.", "Most of each object's state can be made shared and immutable."],
  ["Large memory savings."],
  ["Trades RAM for CPU (extrinsic state recomputed or passed around).", "More complex code."],
  ex(php="""
    final class MarkerStyle {            // intrinsic, shared
        public function __construct(public readonly string $icon, public readonly string $color) {}
    }

    final class MarkerStyles {
        private static array $pool = [];
        public static function get(string $icon, string $color): MarkerStyle {
            return self::$pool["$icon|$color"] ??= new MarkerStyle($icon, $color);
        }
    }

    // extrinsic state (lat/lng) stays per marker
    $markers[] = ['lat' => $lat, 'lng' => $lng, 'style' => MarkerStyles::get('pin.svg', 'red')];
    """, python="""
    from functools import cache

    @dataclass(frozen=True)
    class MarkerStyle:      # intrinsic, shared
        icon: str
        color: str

    @cache
    def marker_style(icon: str, color: str) -> MarkerStyle:
        return MarkerStyle(icon, color)

    markers = [(lat, lng, marker_style("pin.svg", "red")) for lat, lng in points]
    """, dart="""
    class MarkerStyle {
      const MarkerStyle(this.icon, this.color); // intrinsic, shared
      final String icon;
      final int color;
    }

    // `const` instances with equal arguments are canonicalised: Dart shares one object.
    const red = MarkerStyle('pin.svg', 0xFFFF0000);
    final markers = points.map((p) => (lat: p.lat, lng: p.lng, style: red)).toList();
    """),
  ["composite", "singleton"]),

P("proxy", "Proxy", "Structural",
  "Provide a stand-in object that controls access to another object: lazy loading, caching, access checks or remote calls.",
  "You need to run logic before or after access to an object (create it lazily, check permissions, log) without changing the object or its clients.",
  "Create a proxy implementing the same interface that holds (or creates) the real object and forwards calls, adding its control logic.",
  ["Lazy initialisation of a heavy object (virtual proxy).", "Access control (protection proxy).", "Local stand-in for a remote service, or caching/logging."],
  ["Control the service object without clients knowing.", "Works even if the real object isn't ready yet."],
  ["Adds latency/indirection.", "More classes."],
  ex(php="""
    final class LazyReportProxy implements Report {
        private ?Report $real = null;
        public function __construct(private int $id) {}

        public function render(): string {
            $this->real ??= HeavyReport::loadFromWarehouse($this->id);  // created on first use
            return $this->real->render();
        }
    }
    """, python="""
    class LazyReportProxy:
        def __init__(self, report_id: int):
            self._id, self._real = report_id, None

        def render(self) -> str:
            if self._real is None:
                self._real = HeavyReport.load_from_warehouse(self._id)
            return self._real.render()
    """, dart="""
    class LazyReportProxy implements Report {
      LazyReportProxy(this.id);
      final int id;
      // `late final` with an initializer is evaluated lazily on first access.
      late final Report _real = HeavyReport.loadFromWarehouse(id);

      @override
      String render() => _real.render();
    }
    """),
  ["adapter", "decorator", "facade"],
  wild=[{"framework": "Laravel", "note": "Laravel describes its facades as \"static proxies\" to underlying classes in the service container. Calls are forwarded to the resolved instance, which is also why they can be mocked in tests.",
         "url": "https://laravel.com/docs/facades"}]),

# ─────────────────────────── Behavioral ───────────────────────────
P("chain-of-responsibility", "Chain of Responsibility", "Behavioral",
  "Pass a request along a chain of handlers. Each handler either processes it, passes it on, or stops the chain.",
  "A request needs several sequential checks (auth, validation, rate limiting), and hard-wiring them together makes the order and set rigid.",
  "Turn each check into a handler with a reference to the next. Each one decides whether to handle the request, pass it along, or short-circuit.",
  ["Several handlers may process a request, in a configurable order.", "The set of handlers should change at runtime or per route."],
  ["Control the order of handling.", "Add/remove handlers without touching others (OCP, SRP)."],
  ["A request may fall off the end of the chain unhandled.", "Harder to trace which handler did what."],
  ex(php="""
    abstract class Handler {
        private ?Handler $next = null;
        public function then(Handler $next): Handler { return $this->next = $next; }
        public function handle(Request $r): Response {
            return $this->next?->handle($r) ?? new Response(404);
        }
    }

    final class RequireAuth extends Handler {
        public function handle(Request $r): Response {
            return $r->user() ? parent::handle($r) : new Response(401);  // short-circuit
        }
    }

    $chain = new RequireAuth();
    $chain->then(new ThrottleRequests())->then(new RouteToController());
    """, python="""
    Handler = Callable[[Request], Response]

    def require_auth(get_response: Handler) -> Handler:
        def handler(request: Request) -> Response:
            if not request.user:
                return Response(status=401)       # short-circuit
            return get_response(request)          # pass along
        return handler

    app = require_auth(throttle(route_to_view))
    """, dart="""
    typedef Handler = Future<Response> Function(Request);
    typedef Middleware = Handler Function(Handler next);

    Middleware requireAuth = (next) => (req) async =>
        req.user == null ? Response(401) : next(req);

    Handler pipeline(List<Middleware> ms, Handler core) =>
        ms.reversed.fold(core, (next, m) => m(next));
    """),
  ["command", "decorator", "composite"],
  wild=[{"framework": "Laravel", "note": "Middleware are \"a series of 'layers' HTTP requests must pass through\". Each calls `$next($request)` to pass the request on, or returns a response early.",
         "url": "https://laravel.com/docs/middleware"},
        {"framework": "Django", "note": "Middleware wrap the view \"like an onion\". A layer can \"short-circuit and return a response without ever calling its get_response\", and the response passes back out in reverse order.",
         "url": "https://docs.djangoproject.com/en/stable/topics/http/middleware/"}]),

P("command", "Command", "Behavioral",
  "Turn a request into a stand-alone object that holds everything needed to perform it.",
  "You want to queue, schedule, log, retry or undo operations, but they're plain method calls that can't be stored or passed around.",
  "Wrap each operation in a command object with an `execute()` method (and optionally `undo()`). Invokers run commands without knowing what they do.",
  ["Queue or schedule work for later (jobs).", "Support undo/redo.", "Parameterise UI elements (buttons, menu items) with actions."],
  ["Decouples invokers from the work performed.", "Enables queues, retries, logging, undo."],
  ["Many small command classes."],
  ex(php="""
    interface Command { public function execute(): void; }

    final class SendInvoiceEmail implements Command {
        public function __construct(private int $invoiceId) {}
        public function execute(): void { /* load invoice, send mail */ }
    }

    final class Queue {
        private array $commands = [];
        public function push(Command $c): void { $this->commands[] = $c; }
        public function work(): void { while ($c = array_shift($this->commands)) $c->execute(); }
    }
    """, python="""
    @dataclass
    class AddLine:
        doc: Document
        text: str

        def execute(self) -> None:
            self.doc.lines.append(self.text)

        def undo(self) -> None:
            self.doc.lines.pop()

    history: list = []
    cmd = AddLine(doc, "hello"); cmd.execute(); history.append(cmd)
    history.pop().undo()
    """, dart="""
    abstract interface class Command {
      void execute();
      void undo();
    }

    class AddLine implements Command {
      AddLine(this.doc, this.text);
      final Document doc;
      final String text;
      @override
      void execute() => doc.lines.add(text);
      @override
      void undo() => doc.lines.removeLast();
    }
    """),
  ["chain-of-responsibility", "memento", "strategy"],
  wild=[{"framework": "Flutter", "note": "Flutter's architecture guide has view models expose \"commands\" that views call, keeping UI event handling out of the widgets.",
         "url": "https://docs.flutter.dev/app-architecture/guide"}]),

P("iterator", "Iterator", "Behavioral",
  "Traverse the elements of a collection without exposing how it's stored (array, tree, paginated API...).",
  "Every caller that loops over a complex structure has to know its internals, and traversal logic gets duplicated.",
  "Move traversal into an iterator object, or into the language's iterator protocol and generators, so callers just `foreach`.",
  ["The collection has a non-trivial structure.", "You want several ways to traverse the same collection.", "You want to stream large/paginated data lazily."],
  ["Clients don't depend on collection internals.", "Lazy traversal of large or infinite sequences."],
  ["Overkill for simple arrays."],
  ex(php="""
    // Generators make lazy iterators trivial in PHP.
    function allCustomers(ApiClient $api): \\Generator {
        $page = 1;
        do {
            $batch = $api->customers(page: $page++);
            yield from $batch->items;
        } while ($batch->hasMore);
    }

    foreach (allCustomers($api) as $customer) { /* ... */ }
    """, python="""
    def all_customers(api: ApiClient) -> Iterator[Customer]:
        page = 1
        while True:
            batch = api.customers(page=page)
            yield from batch.items
            if not batch.has_more:
                return
            page += 1

    for customer in all_customers(api): ...
    """, dart="""
    // sync* returns a lazy Iterable; async* returns a Stream.
    Stream<Customer> allCustomers(ApiClient api) async* {
      var page = 1;
      while (true) {
        final batch = await api.customers(page: page++);
        yield* Stream.fromIterable(batch.items);
        if (!batch.hasMore) return;
      }
    }

    Future<void> main() async {
      await for (final c in allCustomers(api)) { /* ... */ }
    }
    """),
  ["composite", "visitor"]),

P("mediator", "Mediator", "Behavioral",
  "Reduce chaotic dependencies between objects by making them communicate only through a mediator.",
  "Components (form fields, UI widgets, services) reference each other directly, so changing one ripples through many.",
  "Components notify a mediator of events. The mediator holds the coordination logic and tells the others what to do.",
  ["Many objects interact in complex, tangled ways.", "You want to reuse components independently of each other."],
  ["Components are decoupled and reusable.", "Interaction logic is in one place."],
  ["The mediator can turn into a god object."],
  ex(php="""
    final class CheckoutForm {   // the mediator
        public function __construct(private Field $country, private Field $vat, private Button $submit) {}

        public function changed(Field $field): void {
            if ($field === $this->country) {
                $this->vat->setRequired($this->country->value() === 'ZA');
            }
            $this->submit->setEnabled($this->country->isValid() && $this->vat->isValid());
        }
    }
    """, python="""
    class CheckoutForm:  # the mediator
        def __init__(self, country: Field, vat: Field, submit: Button):
            self.country, self.vat, self.submit = country, vat, submit
            for f in (country, vat):
                f.on_change = self.changed

        def changed(self, field: Field) -> None:
            if field is self.country:
                self.vat.required = self.country.value == "ZA"
            self.submit.enabled = self.country.valid and self.vat.valid
    """, dart="""
    class CheckoutForm { // the mediator
      CheckoutForm(this.country, this.vat, this.submit) {
        country.onChanged = changed;
        vat.onChanged = changed;
      }
      final Field country, vat;
      final Button submit;

      void changed(Field field) {
        if (identical(field, country)) vat.required = country.value == 'ZA';
        submit.enabled = country.isValid && vat.isValid;
      }
    }
    """),
  ["observer", "facade", "chain-of-responsibility"]),

P("memento", "Memento", "Behavioral",
  "Capture and restore an object's previous state without exposing its internals.",
  "Undo or rollback needs snapshots of private state, but copying fields from outside breaks encapsulation.",
  "The originator creates an opaque memento of its own state and can restore from it. A caretaker stores mementos without looking inside.",
  ["Undo/redo or checkpoints.", "Transactions that may need rolling back."],
  ["Snapshots without breaking encapsulation."],
  ["Memory use if snapshots are large or frequent."],
  ex(php="""
    final class Editor {
        private string $text = '';
        public function type(string $s): void { $this->text .= $s; }
        public function save(): EditorMemento { return new EditorMemento($this->text); }
        public function restore(EditorMemento $m): void { $this->text = $m->text; }
    }
    final class EditorMemento { public function __construct(public readonly string $text) {} }

    $history[] = $editor->save();
    $editor->type(' oops');
    $editor->restore(array_pop($history));
    """, python="""
    @dataclass(frozen=True)
    class EditorMemento:
        text: str

    class Editor:
        def __init__(self): self._text = ""
        def type(self, s: str): self._text += s
        def save(self) -> EditorMemento: return EditorMemento(self._text)
        def restore(self, m: EditorMemento): self._text = m.text
    """, dart="""
    // Immutable state objects are mementos for free: keep the previous value.
    var state = const EditorState(text: '');
    final history = <EditorState>[];

    void apply(EditorState next) {
      history.add(state);
      state = next;
    }

    void undo() => state = history.removeLast();
    """),
  ["command", "prototype", "iterator"]),

P("observer", "Observer", "Behavioral",
  "Let objects subscribe to events on another object and be notified automatically when they happen.",
  "When something happens (order shipped, user registered), several unrelated parts of the system must react, and calling each directly couples them all together.",
  "The subject keeps a list of subscribers and notifies them of events. Subscribers register and unregister themselves, and the subject doesn't know what they do.",
  ["Changes to one object require reacting in others you don't want to couple to.", "The set of interested parties changes at runtime."],
  ["Publishers and subscribers are decoupled (OCP).", "Relationships established at runtime."],
  ["Notification order isn't guaranteed.", "Implicit flow is harder to follow and debug."],
  ex(php="""
    final class EventBus {
        private array $listeners = [];
        public function listen(string $event, callable $fn): void { $this->listeners[$event][] = $fn; }
        public function dispatch(object $event): void {
            foreach ($this->listeners[$event::class] ?? [] as $fn) $fn($event);
        }
    }

    $bus->listen(OrderShipped::class, fn (OrderShipped $e) => $sms->send($e->order->phone, 'Shipped!'));
    $bus->dispatch(new OrderShipped($order));
    """, python="""
    class Signal:
        def __init__(self): self._receivers: list[Callable] = []
        def connect(self, fn: Callable) -> None: self._receivers.append(fn)
        def send(self, **kwargs) -> None:
            for fn in self._receivers: fn(**kwargs)

    order_shipped = Signal()
    order_shipped.connect(lambda order: sms.send(order.phone, "Shipped!"))
    order_shipped.send(order=order)
    """, dart="""
    class Cart extends ChangeNotifier {
      final _items = <Item>[];
      List<Item> get items => List.unmodifiable(_items);

      void add(Item item) {
        _items.add(item);
        notifyListeners(); // observers (e.g. ListenableBuilder) rebuild
      }
    }
    """),
  ["mediator", "chain-of-responsibility", "command"],
  wild=[{"framework": "Laravel", "note": "From the docs: \"Laravel's events provide a simple observer pattern implementation.\" Eloquent also has model Observers that group listeners for a model's lifecycle events.",
         "url": "https://laravel.com/docs/events"},
        {"framework": "Django", "note": "Signals let \"senders notify a set of receivers that some action has taken place.\" The docs warn they \"can quickly lead to code that is hard to understand\" and suggest calling the handler directly where possible.",
         "url": "https://docs.djangoproject.com/en/stable/topics/signals/"},
        {"framework": "Flutter", "note": "ChangeNotifier provides \"a change notification API using VoidCallback\": `addListener` / `removeListener` / `notifyListeners`. ValueNotifier is a ChangeNotifier that wraps a single value.",
         "url": "https://api.flutter.dev/flutter/foundation/ChangeNotifier-class.html"}]),

P("state", "State", "Behavioral",
  "Let an object change its behaviour when its internal state changes, as if it changed class.",
  "Methods are full of `switch ($this->status)` blocks, and every new status means editing them all.",
  "Move each state's behaviour into its own class implementing a common interface. The context delegates to the current state object, and states trigger transitions.",
  ["Behaviour depends heavily on state, with many states.", "State-specific conditionals are duplicated across methods."],
  ["Each state's logic is isolated (SRP).", "New states without changing existing ones (OCP)."],
  ["Overkill for a few simple states."],
  ex(php="""
    interface OrderState { public function ship(Order $o): void; }

    final class Paid implements OrderState {
        public function ship(Order $o): void { $o->setState(new Shipped()); }
    }
    final class Pending implements OrderState {
        public function ship(Order $o): void { throw new DomainException('Cannot ship unpaid order'); }
    }

    final class Order {
        public function __construct(private OrderState $state = new Pending()) {}
        public function setState(OrderState $s): void { $this->state = $s; }
        public function ship(): void { $this->state->ship($this); }
    }
    """, python="""
    class Pending:
        def ship(self, order): raise ValueError("Cannot ship unpaid order")

    class Paid:
        def ship(self, order): order.state = Shipped()

    class Order:
        def __init__(self): self.state = Pending()
        def ship(self): self.state.ship(self)
    """, dart="""
    sealed class OrderState {}
    class Pending extends OrderState {}
    class Paid extends OrderState {}
    class Shipped extends OrderState {}

    // Dart 3 sealed classes + exhaustive switch: the compiler checks every state is handled.
    OrderState ship(OrderState s) => switch (s) {
          Pending() => throw StateError('Cannot ship unpaid order'),
          Paid() => Shipped(),
          Shipped() => s,
        };
    """),
  ["strategy", "memento"]),

P("strategy", "Strategy", "Behavioral",
  "Define a family of interchangeable algorithms, put each in its own class, and choose one at runtime.",
  "A class carries several variants of an algorithm (shipping rates, pricing rules, export formats) selected by conditionals that keep growing.",
  "Extract each variant into a strategy implementing a common interface. The context receives a strategy and delegates to it.",
  ["Several variants of an algorithm should be swappable at runtime.", "You want to isolate algorithm details from the code that uses them."],
  ["Swap algorithms at runtime.", "Replace conditionals with composition (OCP).", "Strategies are easy to test alone."],
  ["Clients must know the strategies exist to pick one.", "For a couple of variants, a plain function argument may be enough."],
  ex(php="""
    interface ShippingRate { public function cost(Parcel $p): int; }
    final class FlatRate implements ShippingRate { public function cost(Parcel $p): int { return 5000; } }
    final class ByWeight implements ShippingRate { public function cost(Parcel $p): int { return $p->grams * 3; } }

    final class Checkout {
        public function __construct(private ShippingRate $rate) {}
        public function total(Cart $cart): int { return $cart->subtotal() + $this->rate->cost($cart->parcel()); }
    }
    """, python="""
    # In Python, a strategy is often just a function.
    ShippingRate = Callable[[Parcel], int]

    def flat_rate(p: Parcel) -> int: return 5000
    def by_weight(p: Parcel) -> int: return p.grams * 3

    def total(cart: Cart, rate: ShippingRate = flat_rate) -> int:
        return cart.subtotal() + rate(cart.parcel())
    """, dart="""
    typedef ShippingRate = int Function(Parcel p);

    int flatRate(Parcel p) => 5000;
    int byWeight(Parcel p) => p.grams * 3;

    class Checkout {
      Checkout(this.rate);
      final ShippingRate rate;
      int total(Cart cart) => cart.subtotal + rate(cart.parcel);
    }
    """),
  ["state", "template-method", "bridge", "command", "decorator"],
  wild=[{"framework": "Laravel", "note": "Binding an interface to an implementation in the container (`$this->app->bind(EventPusher::class, RedisEventPusher::class)`), or contextual binding with `when()->needs()->give()`, swaps strategies without touching the classes that use them.",
         "url": LARAVEL_CONTAINER + "#binding-interfaces-to-implementations"}]),

P("template-method", "Template Method", "Behavioral",
  "Define the skeleton of an algorithm in a base class and let subclasses override specific steps.",
  "Several classes run nearly the same algorithm with small differences, so the shared steps are duplicated.",
  "Put the algorithm in a base-class method that calls step methods. Steps are abstract or have defaults (hooks) that subclasses override.",
  ["Several classes share an algorithm's structure but differ in some steps.", "You want to let clients extend only particular steps."],
  ["Shared code lives in one place.", "Clients override only what differs."],
  ["Inheritance-based: rigid, and subclasses can break the skeleton's assumptions (LSP).", "Harder to follow as the number of steps grows."],
  ex(php="""
    abstract class Importer {
        final public function run(string $path): int {          // the template method
            $rows = $this->parse(file_get_contents($path));
            $valid = array_filter($rows, fn ($r) => $this->validate($r));
            return $this->save($valid);
        }
        abstract protected function parse(string $raw): array;
        protected function validate(array $row): bool { return true; }   // hook
        abstract protected function save(array $rows): int;
    }

    final class CsvCustomerImporter extends Importer {
        protected function parse(string $raw): array {
            return array_map('str_getcsv', explode("\n", trim($raw)));
        }
        protected function save(array $rows): int { /* insert customers */ return count($rows); }
    }
    """, python="""
    class Importer(ABC):
        def run(self, path: str) -> int:              # the template method
            rows = self.parse(Path(path).read_text())
            return self.save([r for r in rows if self.validate(r)])

        @abstractmethod
        def parse(self, raw: str) -> list[dict]: ...
        def validate(self, row: dict) -> bool: return True    # hook
        @abstractmethod
        def save(self, rows: list[dict]) -> int: ...
    """, dart="""
    abstract class Importer {
      Future<int> run(String path) async { // the template method
        final rows = parse(await File(path).readAsString());
        return save(rows.where(validate).toList());
      }

      List<Map<String, String>> parse(String raw);
      bool validate(Map<String, String> row) => true; // hook
      Future<int> save(List<Map<String, String>> rows);
    }
    """),
  ["factory-method", "strategy"],
  wild=[{"framework": "Django", "note": "Class-based generic views are built from overridable hooks. For example, `get_form` calls `get_form_class`, which by default returns the `form_class` attribute. Subclasses override just the step they need.",
         "url": "https://docs.djangoproject.com/en/stable/topics/class-based-views/intro/"}]),

P("visitor", "Visitor", "Behavioral",
  "Add new operations to a set of classes without changing them, by moving each operation into a visitor object.",
  "You keep adding unrelated operations (export to XML, compute tax, render) to a stable hierarchy of element classes, bloating them.",
  "Elements implement `accept(visitor)` and call back the visitor method for their type (double dispatch). Each operation is a visitor implementing one method per element type.",
  ["You need many unrelated operations over a stable object structure.", "The element classes rarely change, but operations change often."],
  ["New operations without touching element classes (OCP).", "Related behaviour grouped in one class."],
  ["Adding a new element type means updating every visitor.", "Visitors may need access to element internals."],
  ex(php="""
    interface ShapeVisitor { public function circle(Circle $c): mixed; public function rect(Rect $r): mixed; }
    interface Shape { public function accept(ShapeVisitor $v): mixed; }

    final class Circle implements Shape {
        public function __construct(public float $r) {}
        public function accept(ShapeVisitor $v): mixed { return $v->circle($this); }
    }

    final class AreaVisitor implements ShapeVisitor {
        public function circle(Circle $c): float { return M_PI * $c->r ** 2; }
        public function rect(Rect $r): float { return $r->w * $r->h; }
    }
    """, python="""
    from functools import singledispatch

    # Python alternative to double dispatch: one generic function per operation.
    @singledispatch
    def area(shape) -> float:
        raise NotImplementedError(type(shape))

    @area.register
    def _(c: Circle) -> float: return math.pi * c.r ** 2

    @area.register
    def _(r: Rect) -> float: return r.w * r.h
    """, dart="""
    import 'dart:math';

    sealed class Shape {}
    class Circle extends Shape { Circle(this.r); final double r; }
    class Rect extends Shape { Rect(this.w, this.h); final double w, h; }

    // With sealed classes, an exhaustive switch replaces most visitors.
    double area(Shape s) => switch (s) {
          Circle(:final r) => pi * r * r,
          Rect(:final w, :final h) => w * h,
        };
    """),
  ["composite", "iterator", "command"]),
]

write("design-patterns", {
    "id": "design-patterns",
    "title": "Design Patterns",
    "description": "The 22 classic patterns as catalogued on refactoring.guru: creational, structural and behavioral. Summaries are written for this hub; follow the links for full explanations.",
    "groups": ["Creational", "Structural", "Behavioral"],
    "source": {"name": "refactoring.guru", "url": "https://refactoring.guru/design-patterns/catalog"},
    "entries": entries,
})
