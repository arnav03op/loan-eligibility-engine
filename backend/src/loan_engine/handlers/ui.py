"""GET / → the upload page (served from the Lambda bundle, same origin as the API)."""
from importlib import resources

_html: str | None = None


# Serves the upload page.
def handler(event, context):
    global _html
    if _html is None:
        _html = resources.files("loan_engine").joinpath("static/index.html").read_text("utf-8")
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache"},
        "body": _html,
    }
