"""Оценка одного отчёта. Цвет метки зависит только от входа:
туалет и кнопка вызова показываются в карточке, но на цвет не влияют."""


def report_status(answers: dict) -> str:
    steps = answers.get("steps", "unknown")
    ramp = answers.get("ramp", "unknown")
    door = answers.get("door_wide", "unknown")

    if steps == "unknown":
        return "unknown"
    if door == "no" or (steps == "many" and ramp == "none"):
        return "inaccessible"
    step_free = steps == "none" or ramp == "good"
    if step_free and door == "yes":
        return "accessible"
    return "partial"
