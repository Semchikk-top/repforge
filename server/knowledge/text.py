"""Работа с текстом источника: перевод HTML в текст и нормализация для сверки цитат."""
from __future__ import annotations

import re
import unicodedata
from html.parser import HTMLParser

_SKIP = {"script", "style", "noscript", "svg", "head"}
_BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "table"}


class _Plain(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in _SKIP:
            self.skip += 1
        elif tag in _BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP and self.skip:
            self.skip -= 1
        elif tag in _BLOCK:
            self.out.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.out.append(data)


def html_to_text(html: str) -> str:
    p = _Plain()
    p.feed(html)
    text = "".join(p.out)
    return re.sub(r"\n\s*\n+", "\n\n", re.sub(r"[ \t\r\f\v]+", " ", text)).strip()


def normalize(s: str) -> str:
    """Для сверки цитат: регистр, ё/е, кавычки, тире и переносы строк не важны, важны только слова."""
    s = unicodedata.normalize("NFKC", s).casefold().replace("ё", "е")
    return re.sub(r"[\W_]+", " ", s).strip()
