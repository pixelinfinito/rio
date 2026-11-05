from typing import TypeVar
from pydantic_ai import Agent
from pydantic_ai.output import OutputSpec

T = TypeVar("T")
agent: Agent[None, str] = Agent()

async def forward_output_spec(output_type: OutputSpec[T]) -> T:
    result = await agent.run("testing", output_type=output_type)
    return result.output
